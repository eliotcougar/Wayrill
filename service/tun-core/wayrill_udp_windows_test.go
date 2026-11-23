package tun

import (
	"context"
	"encoding/json"
	"errors"
	stdnet "net"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/xtls/xray-core/app/dispatcher"
	"github.com/xtls/xray-core/app/dns/fakedns"
	"github.com/xtls/xray-core/app/proxyman"
	_ "github.com/xtls/xray-core/app/proxyman/outbound"
	"github.com/xtls/xray-core/app/router"
	"github.com/xtls/xray-core/app/stats"
	"github.com/xtls/xray-core/common/buf"
	"github.com/xtls/xray-core/common/geodata"
	"github.com/xtls/xray-core/common/net"
	"github.com/xtls/xray-core/common/protocol"
	"github.com/xtls/xray-core/common/serial"
	"github.com/xtls/xray-core/common/session"
	"github.com/xtls/xray-core/core"
	"github.com/xtls/xray-core/features/outbound"
	"github.com/xtls/xray-core/features/policy"
	"github.com/xtls/xray-core/features/routing"
	"github.com/xtls/xray-core/proxy/freedom"
	"github.com/xtls/xray-core/proxy/vless"
	"github.com/xtls/xray-core/proxy/vless/encoding"
	vlessoutbound "github.com/xtls/xray-core/proxy/vless/outbound"
	"github.com/xtls/xray-core/transport"
	_ "github.com/xtls/xray-core/transport/internet/tcp"
	"golang.org/x/sys/windows"
)

type udpTestOutbounds struct {
	outbound.Manager
	handlers map[string]*udpTestOutbound
}

func (m udpTestOutbounds) GetHandler(tag string) outbound.Handler { return m.handlers[tag] }
func (m udpTestOutbounds) GetDefaultHandler() outbound.Handler    { return m.handlers["direct"] }

type udpTestPolicy struct{ policy.Manager }

func (udpTestPolicy) ForLevel(uint32) policy.Session { return policy.Session{} }

type udpTestDelivery struct {
	tag, payload, proof string
	destination, target net.Destination
	association         uint64
	owner               session.WayrillUDPOwner
}

type udpTestOutbound struct {
	outbound.Handler
	tag        string
	next       *atomic.Uint64
	deliveries chan<- udpTestDelivery
	closed     chan<- uint64
}

func (h *udpTestOutbound) Tag() string { return h.tag }

func (h *udpTestOutbound) WayrillCanShareUDP() bool {
	return h.tag == "direct" || h.tag == "nat" || h.tag == "dns"
}

func (h *udpTestOutbound) Dispatch(ctx context.Context, link *transport.Link) {
	id := h.next.Add(1)
	defer func() { h.closed <- id }()
	inbound := session.InboundFromContext(ctx)
	outbounds := session.OutboundsFromContext(ctx)
	target := outbounds[len(outbounds)-1].Target
	for {
		packets, err := link.Reader.ReadMultiBuffer()
		for _, packet := range packets {
			h.deliveries <- udpTestDelivery{h.tag, string(packet.Bytes()), inbound.WayrillApplicationProof,
				*packet.UDP, target, id, inbound.WayrillUDPOwner}
			packet.Release()
		}
		if err != nil {
			return
		}
	}
}

func TestWayrillUDPDirectKeepsSocketWhenAliasesAreEvicted(t *testing.T) {
	t.Setenv("WAYRILL_TUN_METADATA", "")

	for _, redirect := range []bool{false, true} {
		name := "direct"
		if redirect {
			name = "redirect"
		}
		t.Run(name, func(t *testing.T) {
			first := listenWayrillUDPEcho(t)
			second := listenWayrillUDPEcho(t)
			config := &freedom.Config{}
			if redirect {
				config.DestinationOverride = &freedom.DestinationOverride{
					Server: &protocol.ServerEndpoint{Port: uint32(first.LocalAddr().(*stdnet.UDPAddr).Port)},
				}
			}
			handler := newUDPTestHandler(t, context.Background(), &core.OutboundHandlerConfig{
				Tag: "egress", ProxySettings: serial.ToTypedMessage(config),
			})
			downlink, full := new(stats.Counter), new(stats.Counter)
			handler.udpReplies = wayrillUDPReplyStats{downlink: downlink, ringFull: full}
			handler.downlinkCounter = downlink
			replies := make(chan udpFlowKey, 1)
			flowHandler := newUdpConnectionHandler(handler.HandleConnection, func(payload []byte, src, dst net.Destination) error {
				if string(payload) == "full" {
					return windows.ERROR_BUFFER_OVERFLOW
				}
				if string(payload) == "reply" {
					replies <- udpFlowKey{src, dst}
				}
				return nil
			})
			flows := newWayrillUDPFlows()
			flowHandler.wayrill = flows
			defer flows.close()
			src := net.UDPDestination(net.ParseAddress("10.90.0.1"), 53001)
			primary := net.DestinationFromAddr(first.LocalAddr())
			alias := net.DestinationFromAddr(second.LocalAddr())
			exchange := func(source, target net.Destination, peer *stdnet.UDPConn) *stdnet.UDPAddr {
				t.Helper()
				flowHandler.HandlePacket(source, target, buf.FromBytes([]byte("query")))
				if err := peer.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
					t.Fatal(err)
				}
				packet := make([]byte, 32)
				n, remote, err := peer.ReadFromUDP(packet)
				if err != nil || string(packet[:n]) != "query" {
					t.Fatalf("packet to %v: received %q, %v", target, packet[:n], err)
				}
				if _, err := peer.WriteToUDP([]byte("reply"), remote); err != nil {
					t.Fatal(err)
				}
				select {
				case reply := <-replies:
					if reply != (udpFlowKey{target, source}) {
						t.Fatalf("reply for %v had endpoints %+v", target, reply)
					}
				case <-time.After(3 * time.Second):
					t.Fatalf("no reply from %v", target)
				}
				return remote
			}

			initial := exchange(src, primary, first)
			if redirect {
				if redirected := exchange(src, alias, first); redirected.Port == initial.Port {
					t.Fatalf("redirected targets shared source port %v", redirected)
				}
				return
			}
			if remote := exchange(src, alias, second); remote.Port != initial.Port {
				t.Fatalf("second destination used %v, want shared socket %v", remote, initial)
			}
			// UDP from one peer is ordered on the same loopback socket. Its second
			// reply must be delivered even when the first hit a full TUN ring.
			for _, payload := range []string{"full", "reply"} {
				if _, err := second.WriteToUDP([]byte(payload), initial); err != nil {
					t.Fatal(err)
				}
			}
			select {
			case <-replies:
			case <-time.After(3 * time.Second):
				t.Fatal("one full ring retired the shared UDP socket")
			}
			if remote := exchange(src, primary, first); remote.Port != initial.Port || full.Value() != 1 {
				t.Fatalf("ring drop changed the association: port=%d drops=%d", remote.Port, full.Value())
			}

			// Saturate the alias cache without opening thousands of real sockets.
			flows.mu.Lock()
			active := flows.flows[udpFlowKey{src, primary}]
			key := udpFlowKey{src, alias}
			otherAddr := net.ParseAddress("192.0.2.1")
			for i := range wayrillUDPAliasLimit {
				flows.addAliasLocked(udpFlowKey{src, net.UDPDestination(otherAddr, net.Port(i+1))}, active, wayrillUDPBinding{})
			}
			evicted := flows.aliases[key] == nil
			flows.mu.Unlock()
			if !evicted {
				t.Fatal("alias cache exceeded its capacity")
			}

			other := src
			other.Port++
			if remote := exchange(other, primary, first); remote.Port == initial.Port {
				t.Fatal("an unrelated source shared the original socket")
			}
			if remote := exchange(src, alias, second); remote.Port != initial.Port {
				t.Fatal("eviction replaced the shared socket")
			}

			// Simulate the deadline passing for the revalidated alias.
			flows.mu.Lock()
			oldEntry := flows.aliases[key]
			oldEntry.Value.(*wayrillUDPAlias).expires = time.Now()
			flows.mu.Unlock()
			if remote := exchange(src, alias, second); remote.Port != initial.Port {
				t.Fatal("expiration replaced the shared socket")
			}
			flows.mu.RLock()
			revalidated := flows.aliases[key] != oldEntry
			flows.mu.RUnlock()
			if !revalidated {
				t.Fatal("expired alias skipped dispatch")
			}
		})
	}
}

type udpTestErrors chan error

func TestWayrillUDPDequeueRequiresCurrentDestinationOwnership(t *testing.T) {
	flows := newWayrillUDPFlows()
	defer flows.close()
	src := net.UDPDestination(net.ParseAddress("192.0.2.1"), 5000)
	primary := net.UDPDestination(net.ParseAddress("192.0.2.2"), 5001)
	alias := net.UDPDestination(net.ParseAddress("192.0.2.3"), 5002)
	conn := &udpConn{
		handler: &udpConnectionHandler{wayrill: flows},
		src:     src, dst: primary, queue: newPacketQueue(2),
		wayrill: &wayrillUDPFlow{key: udpFlowKey{src, primary}},
	}
	flows.flows[conn.wayrill.key] = conn
	flows.addAliasLocked(udpFlowKey{src, alias}, conn, wayrillUDPBinding{until: time.Now().Add(-time.Second)})
	for _, destination := range []net.Destination{alias, primary} {
		b := buf.FromBytes([]byte("packet"))
		b.UDP = &destination
		if !conn.queue.push(b) {
			b.Release()
			t.Fatal("queue setup failed")
		}
	}
	packets, err := conn.ReadMultiBuffer()
	defer buf.ReleaseMulti(packets)
	if err != nil || len(packets) != 1 || *packets[0].UDP != primary {
		t.Fatalf("shared socket dequeued a packet after its destination proof expired: %v", err)
	}
}

func TestWayrillUDPForwardedReplyExpiryAndAccounting(t *testing.T) {
	flows := newWayrillUDPFlows()
	t.Cleanup(flows.close)
	src := net.UDPDestination(net.ParseAddress("192.0.2.1"), 5555)
	primary := net.UDPDestination(net.ParseAddress("198.51.100.1"), 9000)
	peer := primary
	peer.Port++
	writes := 0
	var sinkErr error
	h := newUdpConnectionHandler(nil, func([]byte, net.Destination, net.Destination) error {
		if sinkErr == nil {
			writes++
		}
		return sinkErr
	})
	h.wayrill = flows
	downlink, unverified, full := new(stats.Counter), new(stats.Counter), new(stats.Counter)
	flow := &wayrillUDPFlow{key: udpFlowKey{src, primary}, binding: wayrillUDPBinding{user: "wr-nat", until: time.Now().Add(time.Minute)},
		replies: &wayrillUDPReplyStats{downlink, unverified, full}}
	conn := &udpConn{handler: h, src: src, dst: primary, queue: newPacketQueue(10), wayrill: flow}
	flows.flows[flow.key] = conn
	key := udpFlowKey{src, peer}
	flows.addAliasLocked(key, conn, flow.binding)
	entry := flows.aliases[key]
	reply := func() error {
		p := buf.FromBytes([]byte("reply"))
		p.UDP = &peer
		return conn.WriteMultiBuffer(buf.MultiBuffer{p})
	}
	if err := reply(); err != nil {
		t.Fatal(err)
	}
	sinkErr = windows.ERROR_HANDLE_EOF
	if err := reply(); !errors.Is(err, sinkErr) {
		t.Fatalf("fatal sink error: %v", err)
	}
	sinkErr = nil
	entry.Value.(*wayrillUDPAlias).expires = time.Now()
	if err := reply(); err != nil {
		t.Fatal(err)
	}
	flows.removeAliasLocked(entry)
	if err := reply(); err != nil {
		t.Fatal(err)
	}
	if writes != 1 || downlink.Value() != 5 || unverified.Value() != 2 || full.Value() != 0 {
		t.Fatalf("writes=%d bytes=%d ownership drops=%d ring drops=%d", writes, downlink.Value(), unverified.Value(), full.Value())
	}
}

func TestWayrillUDPFirstObservationWhileRetriesWait(t *testing.T) {
	listener, err := stdnet.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	release := make(chan struct{})
	defer close(release)
	waiting := make(chan struct{}, 4)
	batcher := newWayrillUDPBatcher()
	t.Cleanup(batcher.close)
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				var req struct {
					FirstPass bool
					UDP       [][4]json.RawMessage
				}
				if json.NewDecoder(conn).Decode(&req) != nil {
					return
				}
				for i, tuple := range req.UDP {
					var port uint16
					if json.Unmarshal(tuple[3], &port) != nil {
						return
					}
					if port == 53 && req.FirstPass {
						_ = json.NewEncoder(conn).Encode(map[string]any{"index": i, "pending": true})
						continue
					}
					if !req.FirstPass {
						waiting <- struct{}{}
						<-release
					}
					_ = json.NewEncoder(conn).Encode(map[string]any{"index": i, "identity": wayrillIdentity{Mask: "01"}})
				}
			}()
		}
	}()
	lookup := func(port uint16) (wayrillIdentity, error) {
		return batcher.lookup(context.Background(), listener.Addr().String(), wayrillQuery{DestinationPort: port})
	}
	for range 4 {
		go func() { _, _ = lookup(53) }()
		select {
		case <-waiting:
		case <-time.After(time.Second):
			t.Fatal("retry never reached the helper")
		}
	}
	identity, err := lookup(443)
	if err != nil || identity.Mask != "01" {
		t.Fatalf("ready socket waited behind unresolved peers: %v %v", identity, err)
	}
}

func (e udpTestErrors) SubmitError(err error) {
	select {
	case e <- err:
	default:
	}
}

func TestWayrillUDPVLESSKeepsDestinationAndXUDPPolicy(t *testing.T) {
	t.Setenv("WAYRILL_TUN_METADATA", "")
	user := &protocol.User{Account: serial.ToTypedMessage(&vless.Account{
		Id: "73e115d0-914f-4a3c-87d3-811c55d48f1d", Encryption: "none",
	})}
	memoryUser, err := user.ToMemoryUser()
	if err != nil {
		t.Fatal(err)
	}
	validator := new(vless.MemoryValidator)
	if err := validator.Add(memoryUser); err != nil {
		t.Fatal(err)
	}

	for _, mode := range []string{"plain", "reject", "skip"} {
		t.Run(mode, func(t *testing.T) {
			peer, err := stdnet.ListenTCP("tcp4", &stdnet.TCPAddr{IP: stdnet.IPv4(127, 0, 0, 1)})
			if err != nil {
				t.Fatal(err)
			}
			defer peer.Close()
			config := &core.OutboundHandlerConfig{
				Tag: "proxy",
				ProxySettings: serial.ToTypedMessage(&vlessoutbound.Config{Vnext: &protocol.ServerEndpoint{
					Address: net.NewIPOrDomain(net.LocalHostIP),
					Port:    uint32(peer.Addr().(*stdnet.TCPAddr).Port),
					User:    user,
				}}),
			}
			if mode != "plain" {
				config.SenderSettings = serial.ToTypedMessage(&proxyman.SenderConfig{
					MultiplexSettings: &proxyman.MultiplexingConfig{
						Enabled: true, Concurrency: -1, XudpConcurrency: 2, XudpProxyUDP443: mode,
					},
				})
			}
			failures := make(udpTestErrors, 1)
			handler := newUDPTestHandler(t, session.TrackedConnectionError(context.Background(), failures), config)
			flowHandler := newUdpConnectionHandler(handler.HandleConnection, func([]byte, net.Destination, net.Destination) error { return nil })
			flowHandler.wayrill = newWayrillUDPFlows()
			defer flowHandler.wayrill.close()
			src := net.UDPDestination(net.ParseAddress("10.90.0.1"), 53001)
			send := func(target net.Destination) {
				flowHandler.HandlePacket(src, target, buf.FromBytes([]byte("query")))
			}
			readHeader := func(target net.Destination, command protocol.RequestCommand) {
				t.Helper()
				deadline := time.Now().Add(3 * time.Second)
				if err := peer.SetDeadline(deadline); err != nil {
					t.Fatal(err)
				}
				conn, err := peer.AcceptTCP()
				if err != nil {
					select {
					case failure := <-failures:
						t.Fatalf("no VLESS request for %v: %v", target, failure)
					default:
						t.Fatalf("no VLESS request for %v: %v", target, err)
					}
				}
				t.Cleanup(func() { conn.Close() })
				if err := conn.SetReadDeadline(deadline); err != nil {
					t.Fatal(err)
				}
				_, request, _, _, err := encoding.DecodeRequestHeader(false, nil, conn, validator)
				if err != nil || request.Command != command || (command == protocol.RequestCommandUDP && request.Destination() != target) {
					t.Fatalf("VLESS request for %v: %+v, %v", target, request, err)
				}
			}
			first := net.UDPDestination(net.ParseAddress("192.0.2.1"), 53)
			send(first)
			if mode == "plain" {
				readHeader(first, protocol.RequestCommandUDP)
			} else {
				readHeader(first, protocol.RequestCommandMux)
			}
			second := net.UDPDestination(net.ParseAddress("192.0.2.2"), 443)
			send(second)
			if mode != "reject" {
				readHeader(second, protocol.RequestCommandUDP)
				return
			}
			select {
			case err := <-failures:
				if !strings.Contains(err.Error(), "XUDP rejected UDP/443") {
					t.Fatal(err)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("UDP/443 skipped the outbound reject policy")
			}
		})
	}
}

func newUDPTestHandler(t *testing.T, ctx context.Context, config *core.OutboundHandlerConfig) *Handler {
	t.Helper()
	instance, err := core.New(&core.Config{
		App: []*serial.TypedMessage{
			serial.ToTypedMessage(&proxyman.OutboundConfig{}),
			serial.ToTypedMessage(&dispatcher.Config{}),
		},
		Outbound: []*core.OutboundHandlerConfig{config},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { instance.Close() })
	return &Handler{
		ctx: context.WithValue(ctx, core.XrayKey(1), instance), config: &Config{},
		dispatcher: instance.GetFeature(routing.DispatcherType()).(routing.Dispatcher), tag: "tun",
	}
}

func listenWayrillUDPEcho(t *testing.T) *stdnet.UDPConn {
	t.Helper()
	conn, err := stdnet.ListenUDP("udp4", &stdnet.UDPAddr{IP: stdnet.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

func TestWayrillUDPRejectsRepliesFromRetiredFlow(t *testing.T) {
	flows := newWayrillUDPFlows()
	t.Cleanup(flows.close)
	src := net.UDPDestination(net.ParseAddress("192.0.2.2"), 53001)
	dst := net.UDPDestination(net.ParseAddress("198.51.100.8"), 443)
	connections := make(chan *udpConn, 1)
	writes := 0
	h := newUdpConnectionHandler(func(conn net.Conn, _ net.Destination) {
		connections <- conn.(*udpConn)
	}, func(_ []byte, _, _ net.Destination) error {
		writes++
		return nil
	})
	h.wayrill = flows
	h.HandlePacket(src, dst, buf.FromBytes([]byte{1}))
	var conn *udpConn
	select {
	case conn = <-connections:
	case <-time.After(time.Second):
		t.Fatal("no UDP flow")
	}
	if _, err := conn.Write([]byte{1}); err != nil {
		t.Fatal(err)
	}
	session.AdvanceWayrillUDPEpoch()
	if err := conn.WriteMultiBuffer(buf.MultiBuffer{buf.FromBytes([]byte{2})}); err == nil {
		t.Fatal("reply survived a rule change")
	}
	conn.Close()
	if _, err := conn.Write([]byte{3}); err == nil || writes != 1 {
		t.Fatalf("retired flow reached the packet sink: writes=%d err=%v", writes, err)
	}
}

func TestWayrillUDPDispatchUsesAttributedRoute(t *testing.T) {
	const proof = `{"owner":{"name":"child.exe","pid":42},"matches":[{"process":{"name":"parent.exe","pid":7},"predicates":[0]}]}`
	secret := strings.Repeat("a", 64)
	meta, err := stdnet.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer meta.Close()
	t.Setenv("WAYRILL_TUN_METADATA", meta.Addr().String()+":"+secret+":2:wr-n")
	var replaceDNSOwner atomic.Bool
	var omitDNSOwner atomic.Bool
	var replaceNATAlias atomic.Bool
	go func() {
		for {
			conn, err := meta.Accept()
			if err != nil {
				return
			}
			_ = conn.SetDeadline(time.Now().Add(time.Second))
			var batch struct {
				Auth string               `json:"auth"`
				UDP  [][4]json.RawMessage `json:"udp"`
			}
			if json.NewDecoder(conn).Decode(&batch) != nil || batch.Auth != secret {
				_ = conn.Close()
				continue
			}
			for i, query := range batch.UDP {
				var port uint16
				if json.Unmarshal(query[3], &port) != nil {
					break
				}
				reply := map[string]any{
					"mask": "01", "applicationProof": json.RawMessage(proof),
					"udpOwner": session.WayrillUDPOwner{PID: 42, Started: 123, Endpoint: 246},
				}
				switch port {
				case 53:
					if omitDNSOwner.Load() {
						continue
					}
					if replaceDNSOwner.Load() {
						reply["mask"] = "00"
						delete(reply, "applicationProof")
						reply["udpOwner"] = session.WayrillUDPOwner{PID: 43, Started: 125, Endpoint: 248}
					}
				case 445:
					reply["udpOwner"] = session.WayrillUDPOwner{PID: 42, Started: 124, Endpoint: 247}
				case 446, 447:
					reply["mask"] = "00"
					delete(reply, "applicationProof")
					delete(reply, "udpOwner")
					origin := "192.168.137.10"
					if port == 447 && replaceNATAlias.Load() {
						origin = "192.168.137.11"
					}
					reply["origin"] = map[string]any{"source": origin, "sourcePort": 54001}
				case 448, 449:
					reply["mask"] = "02"
					delete(reply, "applicationProof")
					delete(reply, "udpOwner")
				}
				_ = json.NewEncoder(conn).Encode(map[string]any{"index": i, "identity": reply})
			}
			_ = conn.Close()
		}
	}()

	var next atomic.Uint64
	deliveries := make(chan udpTestDelivery, 16)
	closed := make(chan uint64, 16)
	om := udpTestOutbounds{handlers: make(map[string]*udpTestOutbound)}
	policyRelay := session.WayrillRelayTagPrefix + "policy"
	for _, tag := range []string{"direct", "dns", policyRelay, "nat"} {
		om.handlers[tag] = &udpTestOutbound{tag: tag, next: &next, deliveries: deliveries, closed: closed}
	}
	instance := new(core.Instance)
	ctx := context.WithValue(context.Background(), core.XrayKey(1), instance)
	fake, err := fakedns.NewFakeDNSHolder()
	if err != nil {
		t.Fatal(err)
	}
	defer fake.Close()
	if err := instance.AddFeature(fake); err != nil {
		t.Fatal(err)
	}
	const domain = "child.example"
	fakeIP := fake.GetFakeIPForDomain(domain)[0]
	domains, err := geodata.ParseDomainRules([]string{"full:" + domain}, geodata.Domain_Full)
	if err != nil {
		t.Fatal(err)
	}
	r := new(router.Router)
	mask := "wr-01-" + secret[:48]
	rules := []*router.RoutingRule{
		{TargetTag: &router.RoutingRule_Tag{Tag: "dns"}, RuleTag: "child-dns",
			UserEmail: []string{mask}, PortList: &net.PortList{Range: []*net.PortRange{{From: 53, To: 53}}}},
		{TargetTag: &router.RoutingRule_Tag{Tag: policyRelay}, RuleTag: "child-policy",
			UserEmail: []string{mask}, PortList: &net.PortList{Range: []*net.PortRange{{From: 450, To: 451}}}},
		{TargetTag: &router.RoutingRule_Tag{Tag: "dns"}, RuleTag: "child-fakedns",
			UserEmail: []string{mask}, Domain: domains},
		{TargetTag: &router.RoutingRule_Tag{Tag: "nat"}, RuleTag: "nat-udp", InboundTag: []string{"wr-n"}},
		{TargetTag: &router.RoutingRule_Tag{Tag: "direct"}, RuleTag: "default-udp", Networks: []net.Network{net.Network_UDP}},
	}
	if err := r.Init(ctx, &router.Config{Rule: rules}, nil, om, nil); err != nil {
		t.Fatal(err)
	}
	d := new(dispatcher.DefaultDispatcher)
	if err := d.Init(&dispatcher.Config{}, om, r, udpTestPolicy{}, nil); err != nil {
		t.Fatal(err)
	}
	h := &Handler{ctx: ctx, config: &Config{}, dispatcher: d, tag: "tun",
		sniffingRequest: session.SniffingRequest{Enabled: true, OverrideDestinationForProtocol: []string{"fakedns"}}}
	s, err := NewStack(ctx, StackOptions{MTU: 1500}, h)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	worker := s.(*stack).udp
	replies := 0
	worker.writePacket = func([]byte, net.Destination, net.Destination) error {
		replies++
		return nil
	}
	src := net.UDPDestination(net.ParseAddress("10.90.0.1"), 53001)
	deliverTo := func(dst net.Destination, tag, expectedProof string) udpTestDelivery {
		t.Helper()
		const payload = "payload must survive sniffing"
		s.(*stack).udp.HandlePacket(src, dst, buf.FromBytes([]byte(payload)))
		select {
		case p := <-deliveries:
			if p.tag != tag || p.destination != dst || p.payload != payload || p.proof != expectedProof {
				t.Fatalf("UDP to %v delivered as %+v, want %s", dst, p, tag)
			}
			return p
		case <-time.After(3 * time.Second):
			t.Fatalf("no UDP delivery to %v", dst)
			return udpTestDelivery{}
		}
	}
	deliver := func(port net.Port, tag, expectedProof string) udpTestDelivery {
		t.Helper()
		return deliverTo(net.UDPDestination(net.ParseAddress("192.0.2.1"), port), tag, expectedProof)
	}

	direct := deliver(443, "direct", proof)
	child := deliver(53, "dns", proof)
	if direct.association == child.association || child.owner.PID != 42 || child.owner.Started != 123 {
		t.Fatalf("child-process DNS took the existing association: direct=%+v child=%+v", direct, child)
	}
	if compatible := deliver(444, "direct", proof); compatible.association != direct.association {
		t.Fatalf("compatible destination lost FullCone: %+v", compatible)
	}
	if reused := deliver(445, "direct", proof); reused.association == direct.association || reused.owner.Started != 124 {
		t.Fatalf("a different process generation joined an existing association: %+v", reused)
	}
	natPrimary, natAlias := deliver(446, "nat", ""), deliver(447, "nat", "")
	if natPrimary.association != natAlias.association {
		t.Fatal("same proven Windows NAT origin and route lost FullCone")
	}
	if a, b := deliver(448, "direct", ""), deliver(449, "direct", ""); a.association == b.association {
		t.Fatal("ambiguous owners shared a UDP association")
	}
	if a, b := deliver(450, policyRelay, proof), deliver(451, policyRelay, proof); a.association == b.association {
		t.Fatal("distinct destinations skipped the main core's policy selection")
	}
	a := deliverTo(net.UDPDestination(fakeIP, 452), "dns", proof)
	b := deliverTo(net.UDPDestination(fakeIP, 453), "dns", proof)
	if a.association == b.association || a.target.Address.String() != domain || b.target.Address.String() != domain {
		t.Fatalf("FakeDNS rewrite did not preserve each destination: %+v, %+v", a, b)
	}
	flows := worker.wayrill
	replaceNATAlias.Store(true)
	flows.mu.Lock()
	alias := flows.aliases[udpFlowKey{src, natAlias.destination}].Value.(*wayrillUDPAlias)
	alias.binding.until = time.Now().Add(-time.Second)
	flows.mu.Unlock()
	late := buf.FromBytes([]byte("reply to previous NAT origin"))
	late.UDP = &natAlias.destination
	if err := alias.conn.WriteMultiBuffer(buf.MultiBuffer{late}); err != nil || replies != 0 {
		t.Fatalf("NAT alias rebind injected a reply or stopped the shared socket: writes=%d err=%v", replies, err)
	}
	if current := deliver(446, "nat", ""); current.association != natPrimary.association {
		t.Fatal("revoking one translated destination closed an unrelated NAT route")
	}
	if rebound := deliver(447, "nat", ""); rebound.association == natPrimary.association {
		t.Fatal("a different NAT origin reused the previous route's socket")
	}
	key := udpFlowKey{src, child.destination}
	expireDNSOwner := func() *udpConn {
		flows.mu.Lock()
		defer flows.mu.Unlock()
		conn := flows.flows[key]
		conn.wayrill.binding.until = time.Now().Add(-time.Second)
		return conn
	}
	conn := expireDNSOwner()
	if _, err := conn.Write([]byte("late response")); err != nil || replies != 1 {
		t.Fatalf("valid reply did not survive ownership renewal: writes=%d err=%v", replies, err)
	}
	omitDNSOwner.Store(true)
	expireDNSOwner()
	if _, err := conn.Write([]byte("unproven response")); err != nil || replies != 1 {
		t.Fatalf("failed verification injected a reply or destroyed the association: writes=%d err=%v", replies, err)
	}
	omitDNSOwner.Store(false)
	if got := deliver(53, "dns", proof); got.association != child.association {
		t.Fatal("revalidating the same socket changed the association")
	}
	replaceDNSOwner.Store(true)
	expireDNSOwner()
	flows.mu.Lock()
	refresh := flows.refreshLocked(conn, key, &conn.wayrill.binding)
	pushWayrillPacket(refresh.queue, buf.FromBytes([]byte("old owner's packet")))
	flows.mu.Unlock()
	if _, err := conn.Write([]byte("previous owner's reply")); err == nil || replies != 1 {
		t.Fatalf("retired owner could still receive a reply: writes=%d err=%v", replies, err)
	}
	<-refresh.done
	if got := deliver(53, "direct", ""); got.owner.PID != 43 || got.association == child.association {
		t.Fatalf("rebound tuple retained the previous owner's route: %+v", got)
	}
	replaceDNSOwner.Store(false)
	if err := r.ReloadRules(&router.Config{Rule: rules[len(rules)-1:]}, false); err != nil {
		t.Fatal(err)
	}
	if p := deliver(53, "direct", proof); p.association == direct.association {
		t.Fatal("rule reload retained an old UDP association")
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	deadline := time.After(time.Second)
	for remaining := next.Load(); remaining > 0; remaining-- {
		select {
		case <-closed:
		case <-deadline:
			t.Fatalf("still waiting for %d UDP associations to close", remaining)
		}
	}
}
