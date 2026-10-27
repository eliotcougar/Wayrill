//go:build windows

package tun

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"github.com/xtls/xray-core/app/dns/fakedns"
	xnet "github.com/xtls/xray-core/common/net"
	"github.com/xtls/xray-core/core"
	"github.com/xtls/xray-core/features/dns"
	stdnet "net"
	"net/url"
	"os"
	"runtime"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
	"net/netip"
)

const wayrillICMPConcurrency = 32

type wayrillEchoRequest struct {
	family          byte
	src, dst        netip.Addr
	message, quote  []byte
	ttl, tos, flags uint8
}

type wayrillEchoResponse struct {
	address netip.Addr
	status  uint32
	payload []byte
	ttl     uint8
}

// The service supplies the pre-capture uplink, never the owned TUN adapter.
// No proxy connection is opened: these are actual, source-bound Windows echoes.
type wayrillICMP struct {
	ctx     context.Context
	cancel  context.CancelFunc
	uplink  string
	slots   chan struct{}
	mu      sync.Mutex
	closed  bool
	wg      sync.WaitGroup
	send    func(string, wayrillEchoRequest) (wayrillEchoResponse, error)
	resolve func(context.Context, netip.Addr) (netip.Addr, error)
}

func newWayrillICMP(ctx context.Context, handler *Handler) *wayrillICMP {
	ctx, cancel := context.WithCancel(ctx)
	uplink := ""
	if handler != nil && handler.config != nil {
		uplink = handler.config.AutoOutboundsInterface
	}
	w := &wayrillICMP{ctx: ctx, cancel: cancel, uplink: uplink, slots: make(chan struct{}, wayrillICMPConcurrency), send: wayrillWindowsEcho}
	if endpoint := os.Getenv("WAYRILL_REAL_DNS"); endpoint != "" {
		w.resolve = wayrillEchoResolver(ctx, endpoint)
	}
	return w
}

// Resolve only mapped synthetic addresses, using a cancellable native lookup
// with FakeEnable=false. The actual echo remains source-bound to the uplink.
func wayrillEchoResolver(ctx context.Context, endpoint string) func(context.Context, netip.Addr) (netip.Addr, error) {
	instance := core.FromContext(ctx)
	var engine dns.FakeDNSEngineRev0
	if instance != nil {
		engine, _ = instance.GetFeature((*dns.FakeDNSEngine)(nil)).(dns.FakeDNSEngineRev0)
	}
	uri, err := url.Parse(endpoint)
	var resolver *fakedns.WayrillResolver
	if err == nil {
		resolver, err = fakedns.NewWayrillResolver(uri)
	}
	return func(ctx context.Context, address netip.Addr) (netip.Addr, error) {
		if engine == nil || err != nil {
			return netip.Addr{}, fmt.Errorf("ICMP FakeDNS resolver is unavailable")
		}
		original := xnet.IPAddress(address.AsSlice())
		if !engine.IsIPInIPPool(original) {
			return address, nil
		}
		domain := engine.GetDomainFromFakeDNS(original)
		if domain == "" {
			return netip.Addr{}, fmt.Errorf("unmapped ICMP synthetic destination")
		}
		ips, _, lookupErr := resolver.QueryIP(ctx, domain, dns.IPOption{IPv4Enable: address.Is4(), IPv6Enable: address.Is6()})
		if lookupErr != nil {
			return netip.Addr{}, lookupErr
		}
		for _, ip := range ips {
			real, ok := netip.AddrFromSlice(ip)
			real = real.Unmap()
			if ok && real.Is4() == address.Is4() && !real.IsUnspecified() && !real.IsMulticast() && !engine.IsIPInIPPool(xnet.IPAddress(real.AsSlice())) {
				return real, nil
			}
		}
		return netip.Addr{}, fmt.Errorf("no real ICMP destination of the requested family")
	}
}

func (w *wayrillICMP) close() {
	w.mu.Lock()
	w.closed = true
	w.cancel()
	w.mu.Unlock()
	// Each native call has a two-second deadline; no packet can create another
	// goroutine after closed is set. Drain before tearing down the IP stack.
	w.wg.Wait()
}

func (w *wayrillICMP) forward(r wayrillEchoRequest, deliver func(wayrillEchoResponse)) {
	w.mu.Lock()
	if w.closed || w.uplink == "" || w.ctx.Err() != nil {
		w.mu.Unlock()
		return
	}
	select {
	case w.slots <- struct{}{}:
	default:
		w.mu.Unlock()
		return
	}
	w.wg.Add(1)
	w.mu.Unlock()
	go func() {
		defer w.wg.Done()
		defer func() { <-w.slots }()
		if w.ctx.Err() != nil {
			return
		}
		original := r.dst
		if w.resolve != nil {
			real, err := w.resolve(w.ctx, r.dst)
			if err != nil || !real.IsValid() || real.BitLen() != r.dst.BitLen() || w.ctx.Err() != nil {
				return
			}
			r.dst = real
		}
		reply, err := w.send(w.uplink, r)
		if err != nil || w.ctx.Err() != nil || reply.address.BitLen() != r.dst.BitLen() {
			return
		}
		if reply.status == 0 && (reply.address != r.dst || !bytes.Equal(reply.payload, r.message[8:])) {
			return
		}
		if reply.status == 0 {
			reply.address = original
		}
		deliver(reply)
	}()
}

var wayrillIPHelper = windows.NewLazySystemDLL("iphlpapi.dll")
var wayrillIcmpCreate = wayrillIPHelper.NewProc("IcmpCreateFile")
var wayrillIcmp6Create = wayrillIPHelper.NewProc("Icmp6CreateFile")
var wayrillIcmpClose = wayrillIPHelper.NewProc("IcmpCloseHandle")
var wayrillIcmpEcho4 = wayrillIPHelper.NewProc("IcmpSendEcho2Ex")
var wayrillIcmpEcho6 = wayrillIPHelper.NewProc("Icmp6SendEcho2")

type wayrillEchoKey struct {
	source, destination netip.Addr
	payload             [32]byte
}

var wayrillEchoes = struct {
	sync.Mutex
	pending map[wayrillEchoKey]int
}{pending: make(map[wayrillEchoKey]int)}

// Track only outstanding native echoes. A host can legitimately originate
// an echo using its physical address, so that address alone is not a loop.
func wayrillReserveEcho(r wayrillEchoRequest, source stdnet.IP) (func(), bool) {
	digest := sha256.Sum256(r.message[8:])
	original := wayrillEchoKey{r.src, r.dst, digest}
	address, ok := netip.AddrFromSlice(source)
	if !ok {
		return nil, false
	}
	native := wayrillEchoKey{address, r.dst, digest}
	wayrillEchoes.Lock()
	if wayrillEchoes.pending[original] != 0 {
		wayrillEchoes.Unlock()
		return nil, false
	}
	wayrillEchoes.pending[native]++
	wayrillEchoes.Unlock()
	return func() {
		wayrillEchoes.Lock()
		wayrillEchoes.pending[native]--
		if wayrillEchoes.pending[native] == 0 {
			delete(wayrillEchoes.pending, native)
		}
		wayrillEchoes.Unlock()
	}, true
}

type wayrillIPOptions struct {
	ttl, tos, flags, size uint8
	data                  uintptr
}
type wayrillEchoReply4 struct {
	address, status, milliseconds uint32
	size, reserved                uint16
	data                          uintptr
	options                       wayrillIPOptions
}
type wayrillEchoReply6 struct {
	// IPV6_ADDRESS_EX is packed to one byte in ipexport.h: the IP starts
	// at offset 6, not the sockaddr_in6 offset 8 used for the request.
	address              [26]byte
	status, milliseconds uint32
}

func wayrillUplinkSource(name string, destination netip.Addr) (stdnet.IP, int, error) {
	iface, err := stdnet.InterfaceByName(name)
	if err != nil || iface.Flags&stdnet.FlagUp == 0 {
		return nil, 0, fmt.Errorf("ICMP uplink is unavailable")
	}
	addresses, err := iface.Addrs()
	if err != nil {
		return nil, 0, err
	}
	want4 := destination.Is4()
	for _, address := range addresses {
		ip, _, err := stdnet.ParseCIDR(address.String())
		if err != nil || ip.IsUnspecified() || ip.IsLoopback() || ip.IsMulticast() {
			continue
		}
		if want4 && ip.To4() != nil {
			return ip.To4(), iface.Index, nil
		}
		if !want4 && ip.To4() == nil && (stdnet.IP(destination.AsSlice()).IsLinkLocalUnicast() || !ip.IsLinkLocalUnicast()) {
			return ip.To16(), iface.Index, nil
		}
	}
	return nil, 0, fmt.Errorf("ICMP uplink has no address for this IP family")
}

func wayrillWindowsEcho(uplink string, r wayrillEchoRequest) (wayrillEchoResponse, error) {
	result := wayrillEchoResponse{}
	if len(r.message) < 8 || len(r.message) > 65507 || r.ttl == 0 {
		return result, fmt.Errorf("invalid ICMP request")
	}
	ip := stdnet.IP(r.dst.AsSlice())
	if ip.IsUnspecified() || ip.IsMulticast() || ip.IsLoopback() || ip.Equal(stdnet.IPv4bcast) {
		return result, fmt.Errorf("unsupported ICMP destination")
	}
	source, index, err := wayrillUplinkSource(uplink, r.dst)
	if err != nil {
		return result, err
	}
	// Stop a native request recaptured by Windows without changing its
	// payload/MTU or adding destination bypass routes for TCP/UDP.
	release, ok := wayrillReserveEcho(r, source)
	if !ok {
		return result, fmt.Errorf("ICMP request reentered TUN from its uplink")
	}
	defer release()
	create, send := wayrillIcmpCreate, wayrillIcmpEcho4
	if r.family == 6 {
		create, send = wayrillIcmp6Create, wayrillIcmpEcho6
	}
	h, _, err := create.Call()
	if h == ^uintptr(0) || h == 0 {
		return result, err
	}
	defer wayrillIcmpClose.Call(h)
	data := r.message[8:]
	payload := uintptr(unsafe.Pointer(&r.message[0]))
	if len(data) != 0 {
		payload = uintptr(unsafe.Pointer(&data[0]))
	}
	options := wayrillIPOptions{ttl: r.ttl, tos: r.tos, flags: r.flags}
	buffer := make([]byte, len(data)+256)
	base := uintptr(unsafe.Pointer(&buffer[0]))
	var count uintptr
	if r.family == 4 {
		count, _, err = send.Call(h, 0, 0, 0, uintptr(binary.LittleEndian.Uint32(source)), uintptr(binary.LittleEndian.Uint32(r.dst.AsSlice())), payload, uintptr(len(data)), uintptr(unsafe.Pointer(&options)), base, uintptr(len(buffer)), 2000)
		runtime.KeepAlive(r.message)
		runtime.KeepAlive(source)
		runtime.KeepAlive(options)
		if count == 0 {
			return result, err
		}
		reply := (*wayrillEchoReply4)(unsafe.Pointer(&buffer[0]))
		var address [4]byte
		binary.LittleEndian.PutUint32(address[:], reply.address)
		result.address, result.status, result.ttl = netip.AddrFrom4(address), reply.status, reply.options.ttl
		if reply.status == 0 {
			// Never trust a native reply pointer or size before checking that it
			// belongs to the buffer we allocated for this operation.
			if reply.data < base || reply.data-base > uintptr(len(buffer)) || uintptr(reply.size) > uintptr(len(buffer))-(reply.data-base) {
				return result, fmt.Errorf("invalid ICMP reply bounds")
			}
			result.payload = bytes.Clone(buffer[reply.data-base : reply.data-base+uintptr(reply.size)])
		}
	} else {
		src, dst := windows.RawSockaddrInet6{Family: windows.AF_INET6}, windows.RawSockaddrInet6{Family: windows.AF_INET6}
		copy(src.Addr[:], source)
		copy(dst.Addr[:], r.dst.AsSlice())
		if source.IsLinkLocalUnicast() {
			src.Scope_id = uint32(index)
		}
		if ip.IsLinkLocalUnicast() {
			dst.Scope_id = uint32(index)
		}
		count, _, err = send.Call(h, 0, 0, 0, uintptr(unsafe.Pointer(&src)), uintptr(unsafe.Pointer(&dst)), payload, uintptr(len(data)), uintptr(unsafe.Pointer(&options)), base, uintptr(len(buffer)), 2000)
		runtime.KeepAlive(r.message)
		runtime.KeepAlive(src)
		runtime.KeepAlive(dst)
		runtime.KeepAlive(options)
		if count == 0 {
			return result, err
		}
		reply := (*wayrillEchoReply6)(unsafe.Pointer(&buffer[0]))
		var address [16]byte
		copy(address[:], reply.address[6:22])
		result.address, result.status, result.ttl = netip.AddrFrom16(address), reply.status, 64
		if reply.status == 0 {
			start := int(unsafe.Sizeof(wayrillEchoReply6{}))
			if start+len(data) > len(buffer) {
				return result, fmt.Errorf("invalid ICMPv6 reply bounds")
			}
			result.payload = bytes.Clone(buffer[start : start+len(data)])
		}
	}
	return result, nil
}
