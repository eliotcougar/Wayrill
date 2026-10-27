package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"

	"github.com/xtls/xray-core/app/dns/fakedns"
	"github.com/xtls/xray-core/infra/conf"
)

func runFakeDNS(input io.Reader) error {
	data, err := io.ReadAll(io.LimitReader(input, 1024*1024+1))
	if err != nil || len(data) > 1024*1024 {
		return fmt.Errorf("invalid shared FakeDNS configuration size")
	}
	var request struct {
		Address string          `json:"address"`
		Secret  string          `json:"secret"`
		Config  json.RawMessage `json:"config"`
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&request) != nil || decoder.Decode(new(any)) != io.EOF {
		return fmt.Errorf("invalid shared FakeDNS request")
	}
	address, err := netip.ParseAddrPort(request.Address)
	if err != nil || address.Addr() != netip.MustParseAddr("127.0.0.1") || len(request.Secret) != 64 {
		return fmt.Errorf("invalid shared FakeDNS endpoint")
	}
	if _, err := hex.DecodeString(request.Secret); err != nil {
		return fmt.Errorf("invalid shared FakeDNS credential")
	}
	var config conf.Config
	if err := json.Unmarshal(request.Config, &config); err != nil {
		return err
	}
	if err := conf.PostProcessConfigureFile(&config); err != nil || config.FakeDNS == nil {
		return fmt.Errorf("missing or invalid FakeDNS pools")
	}
	pools, err := config.FakeDNS.Build()
	if err != nil {
		return err
	}
	engine, err := fakedns.NewFakeDNSHolderMulti(pools)
	if err != nil {
		return err
	}
	if err := engine.Start(); err != nil {
		return err
	}
	defer engine.Close()
	canonical, err := json.Marshal(config.FakeDNS)
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp4", request.Address)
	if err != nil {
		return err
	}
	defer listener.Close()
	if err := json.NewEncoder(os.Stdout).Encode(map[string]any{"wayrillFakeDNSReady": listener.Addr().String(), "pools": json.RawMessage(canonical)}); err != nil {
		return err
	}
	return fakedns.WayrillServe(listener, request.Secret, engine)
}

func init() {
	if len(os.Args) != 2 || os.Args[1] != "wayrill-fakedns" {
		return
	}
	if err := runFakeDNS(os.Stdin); err != nil {
		fmt.Fprintln(os.Stderr, "Shared FakeDNS pool failed:", err)
		os.Exit(1)
	}
	os.Exit(0)
}
