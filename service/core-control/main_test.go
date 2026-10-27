package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
)

// Use ordinary valid domains: a large subscription can exceed the RPC limit
// while still fitting the app's JSON budget.
func largeRoutingTable() map[string]any {
	rules := make([]any, 1000)
	for i := range rules {
		domains := make([]string, 100)
		for j := range domains {
			domains[j] = fmt.Sprintf("full:host-%03d.group-%04d.subscription-size-check.example", j, i)
		}
		rules[i] = map[string]any{"type": "field", "domain": domains, "outboundTag": "direct"}
	}
	return map[string]any{"rules": rules}
}

func expectControlSizeLimit(t *testing.T, fields map[string]any) {
	t.Helper()
	fields["address"] = "127.0.0.1:1"
	fields["password"] = strings.Repeat("a", 64)
	fields["prepare"] = true
	input, err := json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	if len(input) > 16*1024*1024 {
		t.Fatal("fixture exceeds the app's configuration budget")
	}
	if err := controlRun(bytes.NewReader(input)); !errors.Is(err, routingLimit) {
		t.Fatalf("expected API size guard before dialing, got %v", err)
	}
}

func TestExpandedRulesAreRejectedBeforeDialing(t *testing.T) {
	expectControlSizeLimit(t, map[string]any{"routing": largeRoutingTable()})
}

func TestControlRejectsInvalidRequests(t *testing.T) {
	for _, input := range []string{`{}`, `{"address":"192.0.2.1:80","password":"` + strings.Repeat("a", 64) + `"}`, `{"address":"127.0.0.1:80","password":"wrong"}`, strings.Repeat("x", controlLimit+1)} {
		if controlRun(strings.NewReader(input)) == nil {
			t.Fatal("accepted malformed request")
		}
	}
}

func TestLargePreviousTableCannotEnterALiveTransaction(t *testing.T) {
	expectControlSizeLimit(t, map[string]any{"previous": largeRoutingTable()})
}
