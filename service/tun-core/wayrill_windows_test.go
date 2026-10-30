//go:build windows

package tun

import (
	"bufio"
	"context"
	"encoding/json"
	"github.com/xtls/xray-core/common/net"
	"github.com/xtls/xray-core/common/session"
	stdnet "net"
	"strings"
	"testing"
	"time"
)

func wayrillProcessEmail(ctx context.Context, source, destination net.Destination) (string, error) {
	return wayrillProcessIdentity(ctx, source, destination, nil)
}

func TestWayrillAttributionIsBoundedAndNeverUsesFallbackOnFailure(t *testing.T) {
	for _, response := range []string{"3", "0", "", "invalid", "33"} {
		t.Run("mask-"+response, func(t *testing.T) {
			listener, err := stdnet.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			auth := strings.Repeat("a", 64)
			t.Setenv("WAYRILL_TUN_METADATA", listener.Addr().String()+":"+auth+":1")
			done := make(chan wayrillQuery, 1)
			go func() {
				conn, err := listener.Accept()
				if err != nil {
					return
				}
				defer conn.Close()
				conn.SetDeadline(time.Now().Add(time.Second))
				payload, _ := bufio.NewReader(conn).ReadBytes('\n')
				var query wayrillQuery
				json.Unmarshal(payload, &query)
				done <- query
				json.NewEncoder(conn).Encode(map[string]string{"mask": response})
			}()
			source := net.TCPDestination(net.ParseAddress("192.0.2.3"), net.Port(54321))
			target := net.UDPDestination(net.ParseAddress("203.0.113.10"), net.Port(53))
			email, err := wayrillProcessEmail(context.Background(), source, target)
			if response == "3" || response == "0" {
				if err != nil || email != "wr-"+response+"-"+auth[:48] {
					t.Fatalf("%q %v", email, err)
				}
			} else if err == nil || email != "" {
				t.Fatalf("malformed attribution became fallback: %q", email)
			}
			query := <-done
			if query.Auth != auth || query.Source != "192.0.2.3" || query.SourcePort != 54321 || query.Destination != "203.0.113.10" || query.DestinationPort != 53 || query.Network != "udp" {
				t.Fatalf("flow metadata lost: %+v", query)
			}
		})
	}
}
func TestWayrillAttributionRequiresValidPrivateEndpoint(t *testing.T) {
	for _, endpoint := range []string{"remote:53:secret:1", "127.0.0.1:1:short:1", "127.0.0.1:1:" + strings.Repeat("a", 64) + ":193"} {
		t.Setenv("WAYRILL_TUN_METADATA", endpoint)
		email, err := wayrillProcessEmail(context.Background(), net.Destination{}, net.Destination{})
		if err == nil || email != "" {
			t.Fatal("accepted invalid private endpoint")
		}
	}
}
func TestWayrillAttributionCancellationClosesPendingRead(t *testing.T) {
	listener, _ := stdnet.Listen("tcp", "127.0.0.1:0")
	defer listener.Close()
	t.Setenv("WAYRILL_TUN_METADATA", listener.Addr().String()+":"+strings.Repeat("a", 64)+":1")
	go func() {
		c, e := listener.Accept()
		if e == nil {
			defer c.Close()
			bufio.NewReader(c).ReadBytes('\n')
			time.Sleep(300 * time.Millisecond)
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := wayrillProcessEmail(ctx, net.TCPDestination(net.ParseAddress("192.0.2.1"), 1), net.TCPDestination(net.ParseAddress("203.0.113.1"), 80))
	if err == nil || time.Since(start) > 250*time.Millisecond {
		t.Fatal("cancelled attribution remained blocked")
	}
}

func TestWayrillSharedIPv6NeverUsesHostProcessAttribution(t *testing.T) {
	for _, test := range []struct{ source, want string }{{"fd28:14:137::2", "wr-ics6"}, {"fd28:14:137::abcd", "wr-ics6"}, {"fd28:14:137::1", ""}, {"fd28:14:137::", ""}, {"fd28:14:138::2", ""}, {"192.168.137.20", ""}} {
		t.Setenv("WAYRILL_TUN_METADATA", "|fd28:14:137::/64")
		value, err := wayrillProcessEmail(context.Background(), net.TCPDestination(net.ParseAddress(test.source), 54321), net.TCPDestination(net.ParseAddress("2001:db8::1"), 443))
		if err != nil || value != test.want {
			t.Fatalf("source %s: %q %v", test.source, value, err)
		}
	}
	// An unavailable host attribution endpoint cannot become an empty identity.
	t.Setenv("WAYRILL_TUN_METADATA", "127.0.0.1:1:"+strings.Repeat("a", 64)+":1|fd28:14:137::/64")
	value, err := wayrillProcessEmail(context.Background(), net.TCPDestination(net.ParseAddress("fd28:14:137::abcd"), 1), net.TCPDestination(net.ParseAddress("2001:db8::1"), 443))
	if err != nil || value != "wr-ics6" {
		t.Fatal("shared clients acquired host predicates")
	}
	_, err = wayrillProcessEmail(context.Background(), net.TCPDestination(net.ParseAddress("fd90::2"), 1), net.TCPDestination(net.ParseAddress("2001:db8::1"), 443))
	if err == nil {
		t.Fatal("lost host attribution became fallback")
	}
}
func TestWayrillSharedScopeRejectsInvalidOrOverbroadPrefixes(t *testing.T) {
	for _, prefix := range []string{"::/0", "fd28:14:137::/48", "fd28:14:137::1/64", "2001:db8::/64", "invalid", "fd28:14:137::/64|other"} {
		t.Setenv("WAYRILL_TUN_METADATA", "|"+prefix)
		value, err := wayrillProcessEmail(context.Background(), net.TCPDestination(net.ParseAddress("fd28:14:137::2"), 1), net.TCPDestination(net.ParseAddress("2001:db8::1"), 443))
		if err == nil || value != "" {
			t.Fatalf("accepted %s", prefix)
		}
	}
}

func TestWayrillReuseAdapterSettingsRequiresExplicitServiceFlag(t *testing.T) {
	for _, value := range []string{"", "0", "true", "yes", "1"} {
		t.Setenv("WAYRILL_TUN_REUSE_SETTINGS", value)
		if got := wayrillReuseAdapterSettings(); got != (value == "1") {
			t.Fatalf("reuse for %q = %v", value, got)
		}
	}
}

func TestWayrillAttributionUsesPlainIPLiteralWireFormat(t *testing.T) {
	for _, address := range []string{"192.0.2.3", "fd90:298::1", "::ffff:192.0.2.3"} {
		for _, network := range []string{"tcp", "udp"} {
			t.Run(address+"-"+network, func(t *testing.T) {
				listener, err := stdnet.Listen("tcp", "127.0.0.1:0")
				if err != nil {
					t.Fatal(err)
				}
				defer listener.Close()
				auth := strings.Repeat("a", 64)
				t.Setenv("WAYRILL_TUN_METADATA", listener.Addr().String()+":"+auth+":1")
				done := make(chan wayrillQuery, 1)
				go func() {
					conn, err := listener.Accept()
					if err != nil {
						return
					}
					defer conn.Close()
					conn.SetDeadline(time.Now().Add(time.Second))
					var query wayrillQuery
					json.NewDecoder(conn).Decode(&query)
					done <- query
					conn.Write([]byte("{\"mask\":\"1\"}\n"))
				}()
				source := net.TCPDestination(net.ParseAddress(address), 54321)
				target := net.TCPDestination(net.ParseAddress("2001:db8::1"), 443)
				if network == "udp" {
					target.Network = net.Network_UDP
				}
				email, err := wayrillProcessEmail(context.Background(), source, target)
				if err != nil || email != "wr-1-"+auth[:48] {
					t.Fatalf("%q %v", email, err)
				}
				select {
				case query := <-done:
					if stdnet.ParseIP(query.Source) == nil || stdnet.ParseIP(query.Destination) == nil || query.Source != source.Address.IP().String() || query.Destination != "2001:db8::1" || query.Network != network || query.SourcePort != 54321 || query.DestinationPort != 443 {
						t.Fatalf("invalid bridge endpoints: %+v", query)
					}
				case <-time.After(time.Second):
					t.Fatal("bridge query did not arrive")
				}
			})
		}
	}
}

func TestWayrillNATIdentityChangesOnlyRoutingMetadata(t *testing.T) {
	for _, separate := range []bool{false, true} {
		listener, err := stdnet.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		auth := strings.Repeat("a", 64)
		endpoint := listener.Addr().String() + ":" + auth + ":1"
		if separate {
			endpoint += ":wr-n"
		}
		t.Setenv("WAYRILL_TUN_METADATA", endpoint)
		go func() {
			defer listener.Close()
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			defer conn.Close()
			conn.SetDeadline(time.Now().Add(time.Second))
			bufio.NewReader(conn).ReadBytes('\n')
			conn.Write([]byte("{\"mask\":\"0\",\"origin\":{\"source\":\"172.30.187.151\",\"sourcePort\":53000}}\n"))
		}()
		wire := net.TCPDestination(net.ParseAddress("10.90.0.1"), 50001)
		inbound := session.Inbound{Source: wire, Tag: "host-tun"}
		email, err := wayrillProcessIdentity(context.Background(), wire, net.TCPDestination(net.ParseAddress("203.0.113.1"), 443), &inbound)
		if err != nil || email != "wr-nat" {
			t.Fatalf("%q %v", email, err)
		}
		if inbound.Source.Address.IP().String() != "172.30.187.151" || inbound.Source.Port != 53000 {
			t.Fatalf("lost original source: %+v", inbound.Source)
		}
		wantTag := "host-tun"
		if separate {
			wantTag = "wr-n"
		}
		if inbound.Tag != wantTag || wire.Address.IP().String() != "10.90.0.1" || wire.Port != 50001 {
			t.Fatal("routing tag or actual NAT wire tuple changed")
		}
	}
}

func TestWayrillNATRejectsMalformedIdentity(t *testing.T) {
	for _, response := range []string{
		`{"mask":"1","origin":{"source":"172.30.1.2","sourcePort":12}}`,
		`{"mask":"0","origin":{"source":"127.2.3.4","sourcePort":12}}`,
		`{"mask":"0","origin":{"source":"::ffff:127.2.3.4","sourcePort":12}}`,
		`{"mask":"0","origin":{"source":"2001:db8::2","sourcePort":12}}`,
		`{"mask":"0","origin":{"source":"172.30.1.2","sourcePort":0}}`,
		`{"mask":"0","origin":{"source":"0.0.0.0","sourcePort":12}}`,
		`{"mask":"0","origin":{"source":"224.0.0.1","sourcePort":12}}`,
		`{"mask":"0","origin":{"source":"guest.invalid","sourcePort":12}}`,
		`{"mask":"0","origin":{"source":"172.30.1.2","sourcePort":12,"extra":true}}`,
		`{"mask":"0"} {"mask":"1"}`,
	} {
		t.Run(response, func(t *testing.T) {
			listener, err := stdnet.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			t.Setenv("WAYRILL_TUN_METADATA", listener.Addr().String()+":"+strings.Repeat("a", 64)+":1:wr-n")
			go func() {
				conn, err := listener.Accept()
				if err != nil {
					return
				}
				defer conn.Close()
				conn.SetDeadline(time.Now().Add(time.Second))
				bufio.NewReader(conn).ReadBytes('\n')
				conn.Write([]byte(response + "\n"))
			}()
			wire := net.TCPDestination(net.ParseAddress("10.90.0.1"), 50001)
			inbound := session.Inbound{Source: wire, Tag: "host-tun"}
			email, err := wayrillProcessIdentity(context.Background(), wire, net.TCPDestination(net.ParseAddress("203.0.113.1"), 443), &inbound)
			if err == nil || email != "" || inbound.Tag != "host-tun" || inbound.Source != wire {
				t.Fatal("invalid identity modified routing metadata")
			}
		})
	}
}
