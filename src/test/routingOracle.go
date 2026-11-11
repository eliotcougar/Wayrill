// Test-only bridge to the pinned Xray router and its public TestRoute handler.
// Build inside the assembled Xray module; no listeners or outbound connections.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"github.com/xtls/xray-core/app/router"
	"github.com/xtls/xray-core/app/router/command"
	"github.com/xtls/xray-core/infra/conf"
	"google.golang.org/protobuf/encoding/protojson"
)

type scenario struct {
	Routing conf.RouterConfig
	Flows   []json.RawMessage
}

func routes(input scenario) ([]string, error) {
	config, err := input.Routing.Build()
	if err != nil {
		return nil, err
	}
	// These scenarios exercise pure routing decisions, without resolver, policy
	// providers or dispatch. Reject accidental dependencies instead of testing a
	// silently modified configuration or accessing the network.
	if config.DomainStrategy != router.Config_AsIs || config.Script != "" || len(config.BalancingRule) != 0 {
		return nil, fmt.Errorf("fixture requires routing providers")
	}
	for _, rule := range config.Rule {
		if rule.Webhook != nil {
			return nil, fmt.Errorf("fixture contains a webhook")
		}
	}
	r := new(router.Router)
	if err := r.Init(context.Background(), config, nil, nil, nil); err != nil {
		return nil, err
	}
	defer r.Close()
	api := command.NewRoutingServer(r, nil)
	result := make([]string, 0, len(input.Flows))
	for index, raw := range input.Flows {
		flow := new(command.RoutingContext)
		if err := protojson.Unmarshal(raw, flow); err != nil {
			return nil, fmt.Errorf("flow %d: %w", index, err)
		}
		route, err := api.TestRoute(context.Background(), &command.TestRouteRequest{RoutingContext: flow})
		if err != nil {
			return nil, fmt.Errorf("flow %d: %w", index, err)
		}
		result = append(result, route.OutboundTag)
	}
	return result, nil
}

func run() error {
	var inputs []scenario
	if err := json.NewDecoder(os.Stdin).Decode(&inputs); err != nil {
		return err
	}
	results := make([][]string, 0, len(inputs))
	for index, input := range inputs {
		result, err := routes(input)
		if err != nil {
			return fmt.Errorf("scenario %d: %w", index, err)
		}
		results = append(results, result)
	}
	return json.NewEncoder(os.Stdout).Encode(results)
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
