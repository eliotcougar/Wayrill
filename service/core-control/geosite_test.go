package main

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/xtls/xray-core/common/geodata"
	"google.golang.org/protobuf/proto"
)

func TestGeositeReverseLookupUsesCoreMatchingAndKeepsGroupsDistinct(t *testing.T) {
	data := &geodata.GeoSiteList{Entry: []*geodata.GeoSite{
		{Code: "SUFFIX", Domain: []*geodata.Domain{{Type: geodata.Domain_Domain, Value: "EXAMPLE.test"}, {Type: geodata.Domain_Regex, Value: "["}}},
		{Code: "EXACT", Domain: []*geodata.Domain{{Type: geodata.Domain_Full, Value: "WWW.Example.test"}}},
		{Code: "CONTAINS", Domain: []*geodata.Domain{{Type: geodata.Domain_Substr, Value: "EXAMPLE"}}},
		{Code: "REGEX", Domain: []*geodata.Domain{{Type: geodata.Domain_Regex, Value: `^www\.example\.test$`}}},
		{Code: "CASE", Domain: []*geodata.Domain{{Type: geodata.Domain_Regex, Value: `^WWW\.example\.test$`}}},
	}}
	wire, err := proto.Marshal(data)
	if err != nil {
		t.Fatal(err)
	}
	for host, want := range map[string][]string{
		"www.example.test":      {"contains", "exact", "regex", "suffix"},
		"example.test":          {"contains", "suffix"},
		"notexample.test":       {"contains"},
		"www.example.test.evil": {"contains"},
		"unrelated.test":        {},
	} {
		rows, err := geositeMatches(context.Background(), wire, host)
		if err != nil {
			t.Fatal(err)
		}
		got := []string{}
		for _, row := range rows {
			got = append(got, row.Code)
			if row.MatchedBy == "" || row.Count < 1 {
				t.Fatalf("missing match evidence: %+v", row)
			}
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("%s: got %v want %v", host, got, want)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := geositeMatches(ctx, wire, "www.example.test"); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancel: %v", err)
	}
	if _, err := geositeMatches(context.Background(), []byte{10, 255}, "www.example.test"); err == nil {
		t.Fatal("truncated dataset accepted")
	}
}
