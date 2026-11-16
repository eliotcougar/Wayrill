package tun

import (
	"context"
	"encoding/json"
	stdnet "net"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/xtls/xray-core/app/dispatcher"
	"github.com/xtls/xray-core/app/dns/fakedns"
	"github.com/xtls/xray-core/app/router"
	"github.com/xtls/xray-core/common/buf"
	"github.com/xtls/xray-core/common/geodata"
	"github.com/xtls/xray-core/common/net"
	"github.com/xtls/xray-core/common/session"
	"github.com/xtls/xray-core/core"
	"github.com/xtls/xray-core/features/outbound"
	"github.com/xtls/xray-core/features/policy"
	"github.com/xtls/xray-core/transport"
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

func TestWayrillUDPDispatchUsesAttributedRoute(t *testing.T) {
	const proof = `{"owner":{"name":"child.exe","pid":42},"matches":[{"process":{"name":"parent.exe","pid":7},"predicates":[0]}]}`
	secret := strings.Repeat("a", 64)
	meta, err := stdnet.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer meta.Close()
	t.Setenv("WAYRILL_TUN_METADATA", meta.Addr().String()+":"+secret+":2:wr-n")
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
				case 445:
					reply["udpOwner"] = session.WayrillUDPOwner{PID: 42, Started: 124, Endpoint: 247}
				case 446, 447:
					reply["mask"] = "00"
					delete(reply, "applicationProof")
					delete(reply, "udpOwner")
					reply["origin"] = map[string]any{"source": "192.168.137.10", "sourcePort": 54001}
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
	if a, b := deliver(446, "nat", ""), deliver(447, "nat", ""); a.association != b.association {
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
