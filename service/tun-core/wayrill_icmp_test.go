//go:build windows

package tun

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	stdnet "net"
	"net/netip"
	"sync/atomic"
	"testing"
	"time"
	"unsafe"

	xnet "github.com/xtls/xray-core/common/net"
)

type icmpTestTun struct{ output chan []byte }

func (t *icmpTestTun) Start() error                      { return nil }
func (t *icmpTestTun) Close() error                      { return nil }
func (t *icmpTestTun) Name() (string, error)             { return "icmp-test", nil }
func (t *icmpTestTun) Index() (int, error)               { return 1, nil }
func (t *icmpTestTun) ReadPacket([]byte) ([]byte, error) { panic("use Input in packet tests") }
func (t *icmpTestTun) WritePacket(header, payload []byte) error {
	t.output <- append(bytes.Clone(header), payload...)
	return nil
}
func testWayrillICMPStack(t *testing.T) (*stack, *icmpTestTun) {
	t.Helper()
	tun := &icmpTestTun{make(chan []byte, 64)}
	made, err := NewStack(context.Background(), StackOptions{Tun: tun, MTU: 1500}, &Handler{config: &Config{AutoOutboundsInterface: "service-selected uplink"}})
	if err != nil {
		t.Fatal(err)
	}
	s := made.(*stack)
	t.Cleanup(func() { s.Close() })
	return s, tun
}
func testWayrillAddress(raw []byte) netip.Addr {
	address, _ := netip.AddrFromSlice(raw)
	return address
}
func testWayrillEcho(family byte) wayrillEchoRequest {
	r := wayrillEchoRequest{family: family, src: netip.MustParseAddr("10.90.0.2"), dst: netip.MustParseAddr("198.51.100.123"), ttl: 37, tos: 8, flags: 2}
	proto, kind := byte(protoICMPv4), byte(8)
	if family == 6 {
		r.src, r.dst = netip.MustParseAddr("fd90::2"), netip.MustParseAddr("2001:db8::7b")
		r.tos, r.flags = 0, 0
		proto, kind = protoICMPv6, 128
	}
	r.message = []byte{kind, 0, 0, 0, 0x12, 0x34, 0, 1, 1, 2, 3, 4}
	var header [ipv6HeaderSize]byte
	n := putIPHeader(header[:], proto, r.src, r.dst)
	if family == 4 {
		header[1], header[6], header[8] = r.tos, 0x40, r.ttl
		binary.BigEndian.PutUint16(r.message[2:], checksum(sum(r.message, 0)))
	} else {
		header[7] = r.ttl
		binary.BigEndian.PutUint16(r.message[2:], transportChecksum(header[:n], proto, r.message, nil))
	}
	setIPLength(header[:n], n+len(r.message))
	r.quote = append(bytes.Clone(header[:n]), r.message...)
	return r
}
func TestWayrillICMPRealReplyAndTimeout(t *testing.T) {
	for _, family := range []byte{4, 6} {
		for _, success := range []bool{true, false} {
			t.Run(fmt.Sprintf("%d/success=%v", family, success), func(t *testing.T) {
				s, tun := testWayrillICMPStack(t)
				r := testWayrillEcho(family)
				called := make(chan wayrillEchoRequest, 1)
				s.icmp.send = func(uplink string, request wayrillEchoRequest) (wayrillEchoResponse, error) {
					if uplink != "service-selected uplink" {
						t.Error("wrong uplink")
					}
					called <- request
					if !success {
						return wayrillEchoResponse{}, fmt.Errorf("timeout")
					}
					return wayrillEchoResponse{address: r.dst, payload: r.message[8:], ttl: 51}, nil
				}
				s.Input(r.quote)
				var request wayrillEchoRequest
				select {
				case request = <-called:
				case <-time.After(time.Second):
					t.Fatal("echo was not forwarded")
				}
				s.icmp.wg.Wait()
				if request.ttl != r.ttl || request.flags != r.flags || request.tos != r.tos || !bytes.Equal(request.message, r.message) {
					t.Fatal("request changed")
				}
				if !success {
					select {
					case <-tun.output:
						t.Fatal("timeout synthesized a reply")
					default:
					}
					return
				}
				var reply []byte
				select {
				case reply = <-tun.output:
				case <-time.After(time.Second):
					t.Fatal("native reply was not delivered")
				}
				p, ok := parsePacket(reply, 0)
				kind := byte(0)
				if family == 6 {
					kind = 129
				}
				if !ok || !p.verified() || p.src != r.dst || p.dst != r.src || p.payload[0] != kind || !bytes.Equal(p.payload[4:], r.message[4:]) {
					t.Fatal("invalid echo reply")
				}
				if family == 4 && (reply[8] != 51 || checksum(sum(reply[:20], 0)) != 0) || family == 6 && reply[7] != 51 {
					t.Fatal("reply TTL/checksum changed")
				}
			})
		}
	}
}
func TestWayrillICMPMalformedEchoCannotFallBackToLocalReply(t *testing.T) {
	for _, family := range []byte{4, 6} {
		r := testWayrillEcho(family)
		for _, kind := range []string{"checksum", "fragment", "routing", "wrong-family"} {
			t.Run(fmt.Sprintf("%d/%s", family, kind), func(t *testing.T) {
				s, tun := testWayrillICMPStack(t)
				var called atomic.Int32
				s.icmp.send = func(string, wayrillEchoRequest) (wayrillEchoResponse, error) {
					called.Add(1)
					return wayrillEchoResponse{}, fmt.Errorf("unexpected")
				}
				raw := bytes.Clone(r.quote)
				switch kind {
				case "checksum":
					raw[len(raw)-1] ^= 1
				case "fragment":
					if family == 4 {
						raw[6] |= 0x20
						raw[10], raw[11] = 0, 0
						binary.BigEndian.PutUint16(raw[10:], checksum(sum(raw[:20], 0)))
					} else {
						raw[6] = 44
						raw = append(raw[:40], append([]byte{58, 0, 0, 1, 0, 0, 0, 1}, raw[40:]...)...)
						binary.BigEndian.PutUint16(raw[4:], uint16(len(raw)-40))
					}
				case "routing":
					if family == 4 {
						raw[0] = 0x46
						raw = append(raw[:20], append([]byte{0, 0, 0, 0}, raw[20:]...)...)
						binary.BigEndian.PutUint16(raw[2:], uint16(len(raw)))
						raw[10], raw[11] = 0, 0
						binary.BigEndian.PutUint16(raw[10:], checksum(sum(raw[:24], 0)))
					} else {
						raw[6] = 43
						raw = append(raw[:40], append([]byte{58, 0, 0, 0, 0, 0, 0, 0}, raw[40:]...)...)
						binary.BigEndian.PutUint16(raw[4:], uint16(len(raw)-40))
					}
				case "wrong-family":
					if family == 4 {
						raw[9] = 58
						raw[10], raw[11] = 0, 0
						binary.BigEndian.PutUint16(raw[10:], checksum(sum(raw[:20], 0)))
					} else {
						raw[6] = 1
					}
				}
				s.Input(raw)
				s.icmp.wg.Wait()
				if called.Load() != 0 {
					t.Fatal("unsupported echo sent upstream")
				}
				select {
				case <-tun.output:
					t.Fatal("unsupported echo answered locally")
				default:
				}
			})
		}
	}
}

func TestWayrillICMPBoundedStopAndInvalidReplies(t *testing.T) {
	r := testWayrillEcho(4)
	for _, reply := range []wayrillEchoResponse{{address: r.dst, payload: []byte("wrong")}, {address: r.src, payload: r.message[8:]}, {status: 11010}} {
		s, _ := testWayrillICMPStack(t)
		s.icmp.send = func(string, wayrillEchoRequest) (wayrillEchoResponse, error) { return reply, nil }
		var delivered atomic.Int32
		s.icmp.forward(r, func(wayrillEchoResponse) { delivered.Add(1) })
		s.icmp.wg.Wait()
		if delivered.Load() != 0 {
			t.Fatal("unverified reply delivered")
		}
	}
	s, _ := testWayrillICMPStack(t)
	release := make(chan struct{})
	var sent, delivered atomic.Int32
	s.icmp.send = func(string, wayrillEchoRequest) (wayrillEchoResponse, error) {
		sent.Add(1)
		<-release
		return wayrillEchoResponse{address: r.dst, payload: r.message[8:]}, nil
	}
	for i := 0; i < wayrillICMPConcurrency*4; i++ {
		s.icmp.forward(r, func(wayrillEchoResponse) { delivered.Add(1) })
	}
	deadline := time.Now().Add(time.Second)
	for sent.Load() < wayrillICMPConcurrency && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	s.icmp.cancel()
	close(release)
	s.icmp.close()
	if sent.Load() != wayrillICMPConcurrency || delivered.Load() != 0 {
		t.Fatal("concurrency or shutdown violated")
	}
	s.icmp.forward(r, func(wayrillEchoResponse) { t.Error("reply after Close") })
	if sent.Load() != wayrillICMPConcurrency {
		t.Fatal("request after Close")
	}
}

func TestWayrillICMPErrorsQuoteOriginalRequest(t *testing.T) {
	for _, family := range []byte{4, 6} {
		r := testWayrillEcho(family)
		for _, status := range []uint32{11002, 11003, 11004, 11005, 11013, 11014} {
			message := wayrillICMPMessage(r, wayrillEchoResponse{status: status})
			if len(message) < 8 || !bytes.Equal(message[8:], r.quote[:len(message)-8]) {
				t.Fatal("error lost original request")
			}
		}
		if wayrillICMPMessage(r, wayrillEchoResponse{status: 11010}) != nil {
			t.Fatal("timeout produced response")
		}
	}
}

func TestWayrillICMPNativeLayout(t *testing.T) {
	if unsafe.Sizeof(wayrillIPOptions{}) != 16 || unsafe.Sizeof(wayrillEchoReply4{}) != 40 || unsafe.Offsetof(wayrillEchoReply4{}.data) != 16 {
		t.Fatal("IPv4 ABI differs from the Windows x64 SDK")
	}
	if unsafe.Sizeof(wayrillEchoReply6{}) != 36 || unsafe.Offsetof(wayrillEchoReply6{}.status) != 28 {
		t.Fatal("packed IPv6 reply ABI differs from the Windows x64 SDK")
	}
}

func TestWayrillICMPRecaptureGuardReleasesAndAllowsPhysicalOrigins(t *testing.T) {
	r := testWayrillEcho(4)
	source := stdnet.IPv4(10, 0, 2, 15).To4()
	r.src = testWayrillAddress(source)
	release, ok := wayrillReserveEcho(r, source)
	if !ok {
		t.Fatal("physical source was mistaken for a loop")
	}
	if _, ok := wayrillReserveEcho(r, source); ok {
		t.Fatal("native recapture was allowed")
	}
	release()
	release, ok = wayrillReserveEcho(r, source)
	if !ok {
		t.Fatal("stale native echo identity")
	}
	release()
}

func TestWayrillICMPRequiresServiceUplink(t *testing.T) {
	w := newWayrillICMP(context.Background(), nil)
	w.send = func(string, wayrillEchoRequest) (wayrillEchoResponse, error) {
		t.Error("native request without a service-selected uplink")
		return wayrillEchoResponse{}, nil
	}
	w.forward(testWayrillEcho(4), func(wayrillEchoResponse) {
		t.Error("reply without a service-selected uplink")
	})
	w.close()
}

// A WireGuard/MASQUE handler must retain upstream's stack behavior rather than
// acquiring the service-only native ICMP policy.
type icmpNonHostHandler struct{}

func (icmpNonHostHandler) HandleConnection(conn stdnet.Conn, _ xnet.Destination) {
	conn.Close()
}

func TestWayrillICMPHookOnlyOwnsHostTun(t *testing.T) {
	for _, handler := range []ConnectionHandler{nil, icmpNonHostHandler{}} {
		for _, family := range []byte{4, 6} {
			r := testWayrillEcho(family)
			tun := &icmpTestTun{make(chan []byte, 1)}
			made, err := NewStack(context.Background(), StackOptions{Tun: tun, MTU: 1500, Addresses: []netip.Addr{r.dst}}, handler)
			if err != nil {
				t.Fatal(err)
			}
			s := made.(*stack)
			if s.icmp != nil {
				t.Fatal("non-host stack acquired the service's native ICMP backend")
			}
			s.Input(r.quote)
			s.Close()
			select {
			case raw := <-tun.output:
				p, ok := parsePacket(raw, 0)
				if !ok || !p.verified() || p.src != r.dst || p.dst != r.src || !bytes.Equal(p.payload[4:], r.message[4:]) {
					t.Fatal("non-host stack's upstream ICMP behavior changed")
				}
			default:
				t.Fatal("non-host stack lost its upstream ICMP behavior")
			}
		}
	}
}

func FuzzWayrillICMPNeverSynthesizesSuccess(f *testing.F) {
	for _, family := range []byte{4, 6} {
		f.Add(testWayrillEcho(family).quote)
	}
	f.Add([]byte{})
	f.Fuzz(func(t *testing.T, raw []byte) {
		if len(raw) > 65575 {
			return
		}
		p, ok := parsePacket(raw, 0)
		if !ok || p.proto != protoICMPv4 && p.proto != protoICMPv6 {
			return
		}
		s, tun := testWayrillICMPStack(t)
		s.icmp.send = func(string, wayrillEchoRequest) (wayrillEchoResponse, error) {
			return wayrillEchoResponse{}, fmt.Errorf("native echo unavailable")
		}
		s.Input(raw)
		s.Close()
		select {
		case <-tun.output:
			t.Fatal("an arbitrary ICMP packet produced a response without a native reply")
		default:
		}
	})
}

func TestWayrillICMPSyntheticMappingKeepsRealEchoValidation(t *testing.T) {
	for _, family := range []byte{4, 6} {
		r := testWayrillEcho(family)
		real := netip.MustParseAddr("192.0.2.123")
		if family == 6 {
			real = netip.MustParseAddr("2001:db8::123")
		}
		s, _ := testWayrillICMPStack(t)
		s.icmp.resolve = func(context.Context, netip.Addr) (netip.Addr, error) { return real, nil }
		s.icmp.send = func(_ string, sent wayrillEchoRequest) (wayrillEchoResponse, error) {
			if sent.dst != real {
				t.Error("synthetic address escaped to the uplink")
			}
			return wayrillEchoResponse{address: real, payload: r.message[8:]}, nil
		}
		var delivered atomic.Int32
		s.icmp.forward(r, func(reply wayrillEchoResponse) {
			if reply.address != r.dst {
				t.Error("reply lost synthetic identity")
			}
			delivered.Add(1)
		})
		s.icmp.wg.Wait()
		if delivered.Load() != 1 {
			t.Fatal("valid real echo did not return")
		}
		s.icmp.resolve = func(context.Context, netip.Addr) (netip.Addr, error) { return netip.Addr{}, fmt.Errorf("unmapped") }
		s.icmp.send = func(string, wayrillEchoRequest) (wayrillEchoResponse, error) {
			t.Error("unmapped synthetic address escaped")
			return wayrillEchoResponse{}, nil
		}
		s.icmp.forward(r, func(wayrillEchoResponse) { t.Error("fabricated response") })
		s.icmp.wg.Wait()
	}
}
