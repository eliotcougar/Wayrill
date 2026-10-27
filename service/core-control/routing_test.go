package main

import (
	"encoding/json"
	"net"
	"strings"
	"testing"

	"github.com/xtls/xray-core/core"
	"github.com/xtls/xray-core/features/routing"
)

func TestControlPreparesAndAppliesRulesThroughAuthenticatedSOCKS(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	password := strings.Repeat("a", 64)
	control := map[string]any{"type": "field", "inboundTag": []string{"api-in"}, "outboundTag": "api"}
	rules := func(tag string) map[string]any {
		return map[string]any{"rules": []any{control, map[string]any{"type": "field", "network": "tcp,udp", "outboundTag": tag}}}
	}
	config, err := json.Marshal(map[string]any{
		"log":       map[string]any{"loglevel": "none"},
		"api":       map[string]any{"tag": "api", "services": []string{"RoutingService"}},
		"inbounds":  []any{map[string]any{"tag": "api-in", "listen": "127.0.0.1", "port": port, "protocol": "socks", "settings": map[string]any{"auth": "password", "accounts": []any{map[string]any{"user": "wayrill", "pass": password}}}}},
		"outbounds": []any{map[string]any{"tag": "old", "protocol": "blackhole"}, map[string]any{"tag": "new", "protocol": "blackhole"}},
		"routing":   rules("old"),
	})
	if err != nil {
		t.Fatal(err)
	}
	instance, err := core.StartInstance("json", config)
	if err != nil {
		t.Fatal(err)
	}
	defer instance.Close()
	router := instance.GetFeature(routing.RouterType()).(routing.Router)
	run := func(credential string, prepare bool) error {
		request, err := json.Marshal(map[string]any{"address": address, "password": credential, "routing": rules("new"), "previous": rules("old"), "prepare": prepare})
		if err != nil {
			return err
		}
		return controlRun(strings.NewReader(string(request)))
	}
	if err := run(password, true); err != nil {
		t.Fatal("routing preflight failed:", err)
	}
	if router.ListRule()[1].GetOutboundTag() != "old" {
		t.Fatal("preflight changed the running table")
	}
	if err := run(strings.Repeat("b", 64), false); err == nil {
		t.Fatal("accepted an incorrect SOCKS credential")
	}
	if router.ListRule()[1].GetOutboundTag() != "old" {
		t.Fatal("unauthorized request changed the running table")
	}
	if err := run(password, false); err != nil {
		t.Fatal("routing update failed:", err)
	}
	if router.ListRule()[0].GetOutboundTag() != "api" || router.ListRule()[1].GetOutboundTag() != "new" {
		t.Fatal("routing update did not retain the control scope and apply the new rules")
	}
}
