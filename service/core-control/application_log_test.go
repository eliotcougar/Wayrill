package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/xtls/xray-core/common/net"
	"github.com/xtls/xray-core/common/protocol"
	"github.com/xtls/xray-core/common/session"
	"github.com/xtls/xray-core/core"
)

func TestApplicationEvidenceTravelsWithTheChosenRoute(t *testing.T) {
	logPath := filepath.Join(t.TempDir(), "routing.log")
	config, err := json.Marshal(map[string]any{
		"log": map[string]any{"access": "none", "error": logPath, "loglevel": "info"},
		"outbounds": []any{
			map[string]any{"tag": "default", "protocol": "blackhole"},
			map[string]any{"tag": "by-app", "protocol": "blackhole"},
		},
		"routing": map[string]any{"rules": []any{
			map[string]any{"type": "field", "ruleTag": "wrr-app", "user": []string{"regexp:^wr-[13579bdf]-[0-9a-f]{48}$"}, "outboundTag": "by-app"},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	instance, err := core.StartInstance("json", config)
	if err != nil {
		t.Fatal(err)
	}
	defer instance.Close()
	proof := `{"owner":{"name":"opera.exe","pid":42},"matches":[{"process":{"name":"codex.exe","pid":37},"predicates":[0]}]}`
	ctx := session.ContextWithInbound(context.Background(), &session.Inbound{
		User:                    &protocol.MemoryUser{Email: "wr-1-" + strings.Repeat("a", 48)},
		WayrillApplicationProof: proof,
	})
	conn, err := core.Dial(ctx, instance, net.TCPDestination(net.ParseAddress("example.test"), 443))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	want := []byte("Hit route rule: [wrr-app] so taking detour [by-app] for [tcp:example.test:443]\twayrill-app=" + proof)
	var output []byte
	for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		output, err = os.ReadFile(logPath)
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(output, want) {
			return
		}
	}
	t.Fatalf("dispatcher did not log the application evidence with its decision: %s", output)
}
