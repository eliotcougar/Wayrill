package main

// A one-shot diagnostic process, not an extension to the public Xray API.
// Matching uses upstream Router; DNS requests pass through the DNS outbound.
import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/xtls/xray-core/app/router"
	command "github.com/xtls/xray-core/app/router/command"
	"github.com/xtls/xray-core/common"
	"github.com/xtls/xray-core/common/buf"
	xlog "github.com/xtls/xray-core/common/log"
	xnet "github.com/xtls/xray-core/common/net"
	"github.com/xtls/xray-core/common/session"
	"github.com/xtls/xray-core/core"
	"github.com/xtls/xray-core/features/dns"
	"github.com/xtls/xray-core/features/outbound"
	"github.com/xtls/xray-core/infra/conf"
	"github.com/xtls/xray-core/transport"
	"github.com/xtls/xray-core/transport/pipe"
	"golang.org/x/net/dns/dnsmessage"
)

type diagnosticRequest struct {
	Mode        string             `json:"mode"`
	Config      json.RawMessage    `json:"config"`
	Route       *diagnosticFlow    `json:"route"`
	ResolvedIPs []string           `json:"resolvedIPs"`
	Process     *diagnosticProcess `json:"process"`
	Handler     string             `json:"handler"`
	Domain      string             `json:"domain"`
	QueryType   string             `json:"queryType"`
	Server      string             `json:"server"`
}

type diagnosticProcess struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

func (p *diagnosticProcess) matches(values []string) bool {
	m := router.NewProcessNameMatcher(values)
	name := strings.TrimSuffix(p.Name, ".exe")
	path := filepath.ToSlash(p.Path)
	if slices.Contains(m.ProcessNames, name) || p.Path != "" && slices.Contains(m.AbsPaths, path) {
		return true
	}
	for _, folder := range m.Folders {
		if path != "" && strings.HasPrefix(path, folder) {
			return true
		}
	}
	return false
}

type diagnosticFlow struct {
	Inbound    string            `json:"inbound"`
	Domain     string            `json:"domain"`
	IPs        []string          `json:"ips"`
	Port       uint32            `json:"port"`
	Network    string            `json:"network"`
	Protocol   string            `json:"protocol"`
	User       string            `json:"user"`
	SourceIP   string            `json:"sourceIP"`
	SourcePort uint32            `json:"sourcePort"`
	LocalIP    string            `json:"localIP"`
	LocalPort  uint32            `json:"localPort"`
	Attributes map[string]string `json:"attributes"`
}

func (f *diagnosticFlow) context() (*command.RoutingContext, error) {
	if f == nil || f.Port == 0 || f.Port > 65535 || f.SourcePort > 65535 || f.LocalPort > 65535 || (f.Network != "tcp" && f.Network != "udp") {
		return nil, errors.New("provide valid ports and TCP or UDP")
	}
	c := &command.RoutingContext{InboundTag: f.Inbound, TargetDomain: strings.TrimSuffix(strings.ToLower(f.Domain), "."), TargetPort: f.Port, Network: xnet.Network_TCP, Protocol: f.Protocol, User: f.User, SourcePort: f.SourcePort, LocalPort: f.LocalPort, Attributes: f.Attributes}
	if f.Network == "udp" {
		c.Network = xnet.Network_UDP
	}
	for _, raw := range f.IPs {
		ip := xnet.ParseIP(raw)
		if ip == nil {
			return nil, errors.New("invalid destination IP")
		}
		c.TargetIPs = append(c.TargetIPs, ip)
	}
	for _, field := range []struct {
		raw    string
		target *[][]byte
	}{{f.SourceIP, &c.SourceIPs}, {f.LocalIP, &c.LocalIPs}} {
		if field.raw != "" {
			ip := xnet.ParseIP(field.raw)
			if ip == nil {
				return nil, errors.New("invalid source or local IP")
			}
			*field.target = append(*field.target, ip)
		}
	}
	if c.TargetDomain == "" && len(c.TargetIPs) == 0 {
		return nil, errors.New("provide a domain or destination IP")
	}
	return c, nil
}

// Only supplied answers are used during route simulation. Never silently resolve
// through the workstation's native DNS or the live core's cache.
type diagnosticDNS struct {
	ips       []xnet.IP
	requested bool
}

func (*diagnosticDNS) Type() interface{} { return dns.ClientType() }
func (*diagnosticDNS) Start() error      { return nil }
func (*diagnosticDNS) Close() error      { return nil }
func (d *diagnosticDNS) LookupIP(_ string, option dns.IPOption) ([]xnet.IP, uint32, error) {
	d.requested = true
	var ips []xnet.IP
	for _, ip := range d.ips {
		if ip.To4() != nil && option.IPv4Enable || ip.To4() == nil && option.IPv6Enable {
			ips = append(ips, ip)
		}
	}
	if len(ips) == 0 {
		return nil, 0, dns.ErrEmptyResponse
	}
	return ips, 0, nil
}

func diagnosticRoute(ctx context.Context, request diagnosticRequest) (any, error) {
	var config struct {
		Routing   *conf.RouterConfig `json:"routing"`
		Outbounds []struct {
			Tag string `json:"tag"`
		} `json:"outbounds"`
	}
	if err := json.Unmarshal(request.Config, &config); err != nil {
		return nil, err
	}
	flow, err := request.Route.context()
	if err != nil {
		return nil, err
	}
	if config.Routing == nil {
		config.Routing = &conf.RouterConfig{}
	}
	c, err := config.Routing.Build()
	if err != nil {
		return nil, err
	}
	if c.Script != "" {
		return nil, errors.New("routing playground does not execute routing scripts")
	}
	original := append([]*router.RoutingRule(nil), c.Rule...)
	c.Rule = nil
	c.BalancingRule = nil
	unknownProcess := make(map[int]string)
	for i, rule := range original {
		// A mixed graph can keep native process rules for proxy inputs alongside
		// capture-mask rules. Irrelevant inputs must not demand an OS identity.
		if len(rule.InboundTag) != 0 && !slices.Contains(rule.InboundTag, flow.InboundTag) {
			continue
		}
		if len(rule.Process) != 0 {
			if request.Process == nil {
				unknownProcess[i] = "supply an application identity for this native process rule"
			} else if request.Process.matches(rule.Process) {
				// Process selectors are alternatives: a supplied executable can
				// satisfy a rule that also lists self/ or xray/.
			} else if slices.Contains(rule.Process, "self/") || slices.Contains(rule.Process, "xray/") {
				unknownProcess[i] = "native self/ and xray/ rules require a real process; synthetic evaluation is unavailable"
			} else {
				continue
			}
		}
		copy := *rule
		copy.Process = nil
		if len(rule.Process) != 0 && len(copy.LocalOs) == 0 {
			copy.LocalOs = []string{runtime.GOOS}
		}
		copy.Webhook = nil
		copy.TargetTag = &router.RoutingRule_Tag{Tag: strconv.Itoa(i)}
		c.Rule = append(c.Rule, &copy)
	}
	resolver := &diagnosticDNS{}
	for _, raw := range request.ResolvedIPs {
		ip := xnet.ParseIP(raw)
		if ip == nil {
			return nil, errors.New("invalid supplied destination IP")
		}
		resolver.ips = append(resolver.ips, ip)
	}
	r := new(router.Router)
	if err := r.Init(ctx, c, resolver, nil, nil); err != nil {
		return nil, err
	}
	defer r.Close()
	result := map[string]any{"ruleIndex": nil, "outboundTag": "", "balancerTag": ""}
	if len(config.Outbounds) != 0 {
		result["outboundTag"] = config.Outbounds[0].Tag
	}
	route, err := r.PickRoute(command.AsRoutingContext(flow))
	if err == nil {
		index, parseErr := strconv.Atoi(route.GetOutboundTag())
		if parseErr != nil || index < 0 || index >= len(original) {
			return nil, errors.New("invalid diagnostic rule identity")
		}
		// Let Xray evaluate order and every other predicate first. Missing
		// process evidence matters only if this rule could decide the route.
		if message := unknownProcess[index]; message != "" {
			return nil, errors.New(message)
		}
		result["ruleIndex"] = index
		result["outboundTag"] = original[index].GetTag()
		result["balancerTag"] = original[index].GetBalancingTag()
	} else if !errors.Is(err, common.ErrNoClue) {
		return nil, err
	}
	result["needsIPs"] = resolver.requested && len(resolver.ips) == 0
	return result, nil
}

type diagnosticTrace struct {
	ElapsedMS int64  `json:"elapsedMs"`
	Message   string `json:"message"`
}
type diagnosticLogger struct {
	mu      sync.Mutex
	start   time.Time
	entries []diagnosticTrace
}

func (l *diagnosticLogger) Handle(message xlog.Message) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if len(l.entries) < 200 {
		text := message.String()
		if len(text) > 2048 {
			text = text[:2048]
		}
		l.entries = append(l.entries, diagnosticTrace{time.Since(l.start).Milliseconds(), text})
	}
}
func (l *diagnosticLogger) snapshot() []diagnosticTrace {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]diagnosticTrace{}, l.entries...)
}

func diagnosticDNSQuery(ctx context.Context, request diagnosticRequest, logger *diagnosticLogger) (any, error) {
	var config conf.Config
	if err := json.Unmarshal(request.Config, &config); err != nil {
		return nil, err
	}
	// The coordinator also normalizes the config. Enforce the isolation boundary
	// here before any core feature or outbound constructor can run.
	if len(config.InboundConfigs) != 0 || config.API != nil || config.Reverse != nil || config.Metrics != nil {
		return nil, errors.New("DNS diagnostics cannot start listeners")
	}
	for _, o := range config.OutboundConfigs {
		if o.Protocol == "tun" || o.Protocol == "wireguard" {
			return nil, errors.New("DNS diagnostics do not start virtual network outbounds")
		}
		// VLESS reverse starts a listener independently of inbounds.
		if o.Protocol == "vless" && o.Settings != nil {
			var settings conf.VLessOutboundConfig
			if err := json.Unmarshal(*o.Settings, &settings); err != nil {
				return nil, err
			}
			if settings.Reverse != nil {
				return nil, errors.New("DNS diagnostics do not start reverse listeners")
			}
		}
	}
	config.LogConfig = nil
	built, err := config.Build()
	if err != nil {
		return nil, err
	}
	instance, err := core.NewWithContext(ctx, built)
	if err != nil {
		return nil, err
	}
	defer instance.Close()
	xlog.RegisterHandler(logger)
	if err := instance.Start(); err != nil {
		return nil, err
	}
	manager := instance.GetFeature(outbound.ManagerType()).(outbound.Manager)
	handler := manager.GetHandler(request.Handler)
	if handler == nil {
		return nil, errors.New("DNS handler is absent from this configuration")
	}
	var qtype dnsmessage.Type
	switch request.QueryType {
	case "A":
		qtype = dnsmessage.TypeA
	case "AAAA":
		qtype = dnsmessage.TypeAAAA
	case "HTTPS":
		qtype = dnsmessage.Type(65)
	case "TXT":
		qtype = dnsmessage.TypeTXT
	default:
		return nil, errors.New("choose A, AAAA, HTTPS or TXT")
	}
	name, err := dnsmessage.NewName(strings.TrimSuffix(request.Domain, ".") + ".")
	if err != nil || name.Length <= 1 {
		return nil, errors.New("invalid DNS name")
	}
	query := dnsmessage.Message{Header: dnsmessage.Header{ID: 1, RecursionDesired: true}, Questions: []dnsmessage.Question{{Name: name, Type: qtype, Class: dnsmessage.ClassINET}}}
	packet, err := query.Pack()
	if err != nil {
		return nil, err
	}
	destination, err := xnet.ParseDestination("udp:" + request.Server)
	if err != nil || destination.Port == 0 || !destination.Address.Family().IsIP() {
		return nil, errors.New("provide a DNS destination IP and port")
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	ctx = session.ContextWithInbound(ctx, &session.Inbound{Tag: "wayrill-diagnostic"})
	ctx = session.ContextWithOutbounds(ctx, []*session.Outbound{{Target: destination}})
	input, send := pipe.New(pipe.WithSizeLimit(64 * 1024))
	response, output := pipe.New(pipe.WithSizeLimit(64 * 1024))
	defer input.Interrupt()
	defer send.Close()
	defer response.Interrupt()
	defer output.Close()
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		handler.Dispatch(ctx, &transport.Link{Reader: input, Writer: output})
	}()
	defer func() {
		cancel()
		input.Interrupt()
		response.Interrupt()
		<-finished
	}()
	b := buf.New()
	b.Write(packet)
	if err := send.WriteMultiBuffer(buf.MultiBuffer{b}); err != nil {
		return nil, err
	}
	// ReadMultiBuffer itself has no caller context; interrupt its owned pipe on
	// cancellation so a Drop rule and an unreachable resolver both terminate.
	readDone := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			response.Interrupt()
		case <-readDone:
		}
	}()
	data, err := response.ReadMultiBuffer()
	close(readDone)
	if err != nil {
		return map[string]any{"answers": []any{}, "error": "No DNS response (request dropped, resolver failed or deadline reached).", "trace": logger.snapshot()}, nil
	}
	defer buf.ReleaseMulti(data)
	var wire []byte
	for _, part := range data {
		wire = append(wire, part.Bytes()...)
	}
	var reply dnsmessage.Message
	if err := reply.Unpack(wire); err != nil {
		return nil, err
	}
	if reply.ID != 1 || !reply.Response {
		return nil, errors.New("invalid DNS response")
	}
	answers := []map[string]any{}
	engine, _ := instance.GetFeature((*dns.FakeDNSEngine)(nil)).(dns.FakeDNSEngineRev0)
	for _, answer := range reply.Answers {
		value := fmt.Sprint(answer.Body)
		synthetic := false
		switch body := answer.Body.(type) {
		case *dnsmessage.AResource:
			value = xnet.IP(body.A[:]).String()
			synthetic = engine != nil && engine.IsIPInIPPool(xnet.IPAddress(xnet.IP(body.A[:])))
		case *dnsmessage.AAAAResource:
			value = xnet.IP(body.AAAA[:]).String()
			synthetic = engine != nil && engine.IsIPInIPPool(xnet.IPAddress(xnet.IP(body.AAAA[:])))
		case *dnsmessage.CNAMEResource:
			value = body.CNAME.String()
		case *dnsmessage.TXTResource:
			quoted := make([]string, len(body.TXT))
			for i, text := range body.TXT {
				quoted[i] = strconv.Quote(text)
			}
			value = strings.Join(quoted, " ")
		case *dnsmessage.UnknownResource:
			value = fmt.Sprintf(`\# %d %x`, len(body.Data), body.Data)
		}
		answers = append(answers, map[string]any{"name": answer.Header.Name.String(), "type": uint16(answer.Header.Type), "ttl": answer.Header.TTL, "value": value, "synthetic": synthetic})
	}
	return map[string]any{"rcode": reply.RCode.String(), "answers": answers, "trace": logger.snapshot()}, nil
}

func diagnosticRun(input io.Reader) (any, error) {
	data, err := io.ReadAll(io.LimitReader(input, controlLimit+1))
	if err != nil || len(data) > controlLimit {
		return nil, errors.New("invalid diagnostic request size")
	}
	var request diagnosticRequest
	if err := json.Unmarshal(data, &request); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	logger := &diagnosticLogger{start: time.Now()}
	xlog.RegisterHandler(logger)
	switch request.Mode {
	case "route":
		return diagnosticRoute(ctx, request)
	case "dns":
		return diagnosticDNSQuery(ctx, request, logger)
	default:
		return nil, errors.New("unknown diagnostic mode")
	}
}

func init() {
	if len(os.Args) != 2 || os.Args[1] != "wayrill-diagnose" {
		return
	}
	result, err := diagnosticRun(os.Stdin)
	if err != nil {
		result = map[string]any{"error": err.Error()}
	}
	json.NewEncoder(os.Stdout).Encode(result)
	os.Exit(0)
}
