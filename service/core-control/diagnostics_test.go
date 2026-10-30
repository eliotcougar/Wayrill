package main

import (
	"context"
	"encoding/json"
	"golang.org/x/net/dns/dnsmessage"
	"net"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestDiagnosticRoutingUsesOrderedXrayPredicates(t *testing.T) {
	request := diagnosticRequest{Mode: "route", Config: json.RawMessage(`{"outbounds":[{"tag":"default"}],"routing":{"rules":[{"type":"field","domain":["domain:example.com"],"network":"udp","outboundTag":"udp"},{"type":"field","domain":["regexp:^www\\.example\\.com$"],"port":"443","balancerTag":"group","webhook":{"url":"https://must-not-be-called.invalid/"}},{"type":"field","domain":["domain:example.com"],"outboundTag":"later"}],"balancers":[{"tag":"group","selector":["missing"]}]}}`), Route: &diagnosticFlow{Inbound: "proxy", Domain: "www.example.com", Port: 443, Network: "tcp"}}
	result, err := diagnosticRoute(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	r := result.(map[string]any)
	if r["ruleIndex"] != 1 || r["balancerTag"] != "group" || r["needsIPs"] != false {
		t.Fatalf("incorrect first match: %#v", r)
	}
	request.Route.Domain = "elsewhere.test"
	result, err = diagnosticRoute(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if r := result.(map[string]any); r["ruleIndex"] != nil || r["outboundTag"] != "default" {
		t.Fatalf("incorrect default: %#v", r)
	}
}

func TestDiagnosticRoutingDoesNotInventDNSOrProcessIdentity(t *testing.T) {
	request := diagnosticRequest{Config: json.RawMessage(`{"outbounds":[{"tag":"default"}],"routing":{"domainStrategy":"IPIfNonMatch","rules":[{"type":"field","ip":["192.0.2.0/24"],"outboundTag":"address-match"}]}}`), Route: &diagnosticFlow{Domain: "example.test", Port: 443, Network: "tcp"}}
	result, err := diagnosticRoute(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if result.(map[string]any)["needsIPs"] != true {
		t.Fatal("missing DNS input was concealed")
	}
	request.ResolvedIPs = []string{"192.0.2.8"}
	result, err = diagnosticRoute(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if r := result.(map[string]any); r["outboundTag"] != "address-match" || r["needsIPs"] != false {
		t.Fatalf("supplied lookup not used: %#v", r)
	}
	request.Config = json.RawMessage(`{"routing":{"rules":[{"type":"field","process":["browser.exe"],"outboundTag":"app"}]}}`)
	if _, err = diagnosticRoute(context.Background(), request); err == nil {
		t.Fatal("native process matching must require supplied evidence")
	}
	request.Process = &diagnosticProcess{Name: "browser.exe"}
	result, err = diagnosticRoute(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if result.(map[string]any)["outboundTag"] != "app" {
		t.Fatal("process-only rule was lost")
	}
	request.Process = nil
	request.Route.Inbound = "tun"
	request.Config = json.RawMessage(`{"outbounds":[{"tag":"default"}],"routing":{"rules":[{"type":"field","inboundTag":["proxy"],"process":["self/"],"outboundTag":"not-this-input"}]}}`)
	result, err = diagnosticRoute(context.Background(), request)
	if err != nil || result.(map[string]any)["outboundTag"] != "default" {
		t.Fatalf("unrelated proxy process rule blocked TUN evaluation: %v %#v", err, result)
	}
}

func TestDiagnosticDNSExercisesHostsAndRequestPolicies(t *testing.T) {
	request := diagnosticRequest{Config: json.RawMessage(`{"inbounds":[],"outbounds":[{"tag":"direct","protocol":"freedom"},{"tag":"handler","protocol":"dns","settings":{"rules":[{"qType":"28","action":"return","rCode":3}]}}],"dns":{"hosts":{"full:example.test":["192.0.2.9"]},"servers":["localhost"]}}`), Handler: "handler", Domain: "example.test", QueryType: "A", Server: "8.8.8.8:53"}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	logger := &diagnosticLogger{start: time.Now()}
	result, err := diagnosticDNSQuery(ctx, request, logger)
	if err != nil {
		t.Fatal(err)
	}
	r := result.(map[string]any)
	answers := r["answers"].([]map[string]any)
	if len(answers) != 1 || answers[0]["value"] != "192.0.2.9" {
		t.Fatalf("static host was bypassed: %#v", r)
	}
	request.QueryType = "AAAA"
	result, err = diagnosticDNSQuery(ctx, request, logger)
	if err != nil {
		t.Fatal(err)
	}
	if result.(map[string]any)["rcode"] != "RCodeNameError" {
		t.Fatalf("DNS request policy was bypassed: %#v", result)
	}
}

func TestDiagnosticDNSDropAndIsolation(t *testing.T) {
	request := diagnosticRequest{Config: json.RawMessage(`{"inbounds":[],"outbounds":[{"tag":"handler","protocol":"dns","settings":{"rules":[{"action":"drop"}]}}],"dns":{"hosts":{"example.test":"192.0.2.9"}}}`), Handler: "handler", Domain: "example.test", QueryType: "A", Server: "8.8.8.8:53"}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	result, err := diagnosticDNSQuery(ctx, request, &diagnosticLogger{start: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	if result.(map[string]any)["error"] == nil {
		t.Fatal("dropped DNS query falsely succeeded")
	}
	request.Config = json.RawMessage(`{"inbounds":[{"protocol":"tun"}],"outbounds":[]}`)
	if _, err = diagnosticDNSQuery(ctx, request, &diagnosticLogger{start: time.Now()}); err == nil {
		t.Fatal("a diagnostic was allowed to create a TUN inbound")
	}
}

func TestDiagnosticDNSFallbackAndFreshFakeDNS(t *testing.T) {
	server := func(address [4]byte) (int, *atomic.Int32) {
		conn, err := net.ListenPacket("udp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		done := make(chan struct{})
		count := new(atomic.Int32)
		go func() {
			defer close(done)
			packet := make([]byte, 4096)
			for {
				n, peer, err := conn.ReadFrom(packet)
				if err != nil {
					return
				}
				var query dnsmessage.Message
				if query.Unpack(packet[:n]) != nil || len(query.Questions) != 1 {
					continue
				}
				count.Add(1)
				query.Response = true
				query.RecursionAvailable = true
				query.Answers = []dnsmessage.Resource{{Header: dnsmessage.ResourceHeader{Name: query.Questions[0].Name, Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET, TTL: 60}, Body: &dnsmessage.AResource{A: address}}}
				reply, err := query.Pack()
				if err == nil {
					conn.WriteTo(reply, peer)
				}
			}
		}()
		t.Cleanup(func() { conn.Close(); <-done })
		return conn.LocalAddr().(*net.UDPAddr).Port, count
	}
	first, firstCount := server([4]byte{192, 0, 2, 1})
	second, secondCount := server([4]byte{198, 51, 100, 2})
	config := `{"inbounds":[],"outbounds":[{"tag":"direct","protocol":"freedom"},{"tag":"handler","protocol":"dns"}],"dns":{"queryStrategy":"UseIPv4","servers":[{"address":"127.0.0.1","port":FIRST,"domains":["full:example.test"],"expectedIPs":["198.51.100.0/24"]},{"address":"127.0.0.1","port":SECOND}]}}`
	config = strings.ReplaceAll(strings.ReplaceAll(config, "FIRST", strconv.Itoa(first)), "SECOND", strconv.Itoa(second))
	request := diagnosticRequest{Config: json.RawMessage(config), Handler: "handler", Domain: "example.test", QueryType: "A", Server: "8.8.8.8:53"}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	result, err := diagnosticDNSQuery(ctx, request, &diagnosticLogger{start: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	answers, ok := result.(map[string]any)["answers"].([]map[string]any)
	if !ok || len(answers) != 1 || answers[0]["value"] != "198.51.100.2" || firstCount.Load() == 0 || secondCount.Load() == 0 {
		t.Fatalf("real fallback not exercised: %#v", result)
	}
	request.Config = json.RawMessage(`{"inbounds":[],"outbounds":[{"tag":"handler","protocol":"dns"}],"dns":{"servers":["fakedns"]},"fakedns":[{"ipPool":"198.18.0.0/15","poolSize":16}]}`)
	result, err = diagnosticDNSQuery(ctx, request, &diagnosticLogger{start: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	answers, ok = result.(map[string]any)["answers"].([]map[string]any)
	if !ok || len(answers) != 1 || answers[0]["synthetic"] != true {
		t.Fatalf("test mapping not identified: %#v", result)
	}
}
