//go:build windows

// Wayrill TUN attribution bridge. Applied only to the pinned private TUN worker.
package tun

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	stdnet "net"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/xtls/xray-core/common/net"
	"github.com/xtls/xray-core/common/session"
)

// Only the service sets this after proving owned addresses/routes/MTU.
// Gateway remains in the packet stack's configuration on every start.
func wayrillReuseAdapterSettings() bool {
	return os.Getenv("WAYRILL_TUN_REUSE_SETTINGS") == "1"
}

type wayrillQuery struct {
	Auth            string `json:"auth"`
	Network         string `json:"network"`
	Source          string `json:"source"`
	SourcePort      uint16 `json:"sourcePort"`
	Destination     string `json:"destination"`
	DestinationPort uint16 `json:"destinationPort"`
}

// Failure closes this flow before dispatch; it must not masquerade as an empty
// process identity and accidentally select the ordinary unmatched route.
func wayrillProcessIdentity(ctx context.Context, source, destination net.Destination, inbound *session.Inbound) (string, error) {
	endpoint := os.Getenv("WAYRILL_TUN_METADATA")
	if endpoint == "" {
		return "", nil
	}
	parts := strings.Split(endpoint, "|")
	if len(parts) > 2 {
		return "", fmt.Errorf("invalid TUN shared scope")
	}
	fields := strings.Split(parts[0], ":")
	width := 0
	if parts[0] != "" {
		if (len(fields) != 4 && len(fields) != 5) || fields[0] != "127.0.0.1" || len(fields[2]) != 64 || (len(fields) == 5 && fields[4] != "wayrill-runtime-nat") {
			return "", fmt.Errorf("invalid TUN attribution endpoint")
		}
		var err error
		width, err = strconv.Atoi(fields[3])
		if err != nil || width < 1 || width > 192 {
			return "", fmt.Errorf("invalid TUN attribution width")
		}
	}
	if len(parts) == 2 {
		prefix, err := netip.ParsePrefix(parts[1])
		if err != nil || prefix.Bits() != 64 || !prefix.Addr().Is6() || prefix.Addr().As16()[0] != 0xfd || prefix != prefix.Masked() {
			return "", fmt.Errorf("invalid TUN shared scope")
		}
		if source.Address == nil {
			return "", fmt.Errorf("missing TUN source")
		}
		if source.Address.Family().IsIP() {
			src, ok := netip.AddrFromSlice(source.Address.IP())
			if ok && prefix.Contains(src.Unmap()) && src != prefix.Addr() && src != prefix.Addr().Next() {
				return "wr-ics6", nil
			}
		}
	}
	if parts[0] == "" {
		return "", nil
	}

	network := "tcp"
	if destination.Network == net.Network_UDP {
		network = "udp"
	}
	// The bridge carries IP literals, not URI authorities. Xray Address.String
	// adds brackets to IPv6, which is not a parseable literal at the receiver.
	if source.Address == nil || destination.Address == nil || !source.Address.Family().IsIP() || !destination.Address.Family().IsIP() {
		return "", fmt.Errorf("TUN attribution requires IP endpoints")
	}
	request := wayrillQuery{fields[2], network, source.Address.IP().String(), uint16(source.Port), destination.Address.IP().String(), uint16(destination.Port)}
	dialer := stdnet.Dialer{Timeout: 1800 * time.Millisecond}
	conn, err := dialer.DialContext(ctx, "tcp", strings.Join(fields[:2], ":"))
	if err != nil {
		return "", fmt.Errorf("TUN attribution unavailable: %w", err)
	}
	defer conn.Close()
	stopCancel := context.AfterFunc(ctx, func() { conn.Close() })
	defer stopCancel()
	if err = conn.SetDeadline(time.Now().Add(1800 * time.Millisecond)); err != nil {
		return "", err
	}
	payload, err := json.Marshal(request)
	if err != nil {
		return "", err
	}
	if _, err = conn.Write(append(payload, '\n')); err != nil {
		return "", err
	}
	reader := bufio.NewReaderSize(conn, 1024)
	mask, err := reader.ReadSlice('\n')
	if err != nil {
		return "", fmt.Errorf("TUN flow attribution unresolved: %w", err)
	}
	var response struct {
		Mask   string `json:"mask"`
		Origin *struct {
			Source     string `json:"source"`
			SourcePort uint16 `json:"sourcePort"`
		} `json:"origin,omitempty"`
	}
	decoder := json.NewDecoder(bytes.NewReader(mask))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&response); err != nil {
		return "", fmt.Errorf("invalid TUN identity response: %w", err)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return "", fmt.Errorf("trailing TUN identity response")
	}
	value := response.Mask
	if len(value) != width || strings.Trim(value, "0123456789abcdef") != "" {
		return "", fmt.Errorf("invalid TUN attribution response")
	}
	if response.Origin != nil {
		origin, err := netip.ParseAddr(response.Origin.Source)
		origin = origin.Unmap()
		wire, ok := netip.AddrFromSlice(source.Address.IP())
		if err != nil || !ok || origin.Zone() != "" || origin.IsUnspecified() || origin.IsMulticast() || origin.IsLoopback() || origin.Unmap().Is4() != wire.Unmap().Is4() || response.Origin.SourcePort == 0 || strings.Trim(value, "0") != "" {
			return "", fmt.Errorf("invalid TUN NAT identity")
		}
		if inbound != nil {
			// Change routing context only; the packet stack retains NAT wire endpoints.
			inbound.Source = net.Destination{Network: source.Network, Address: net.IPAddress(origin.Unmap().AsSlice()), Port: net.Port(response.Origin.SourcePort)}
			if len(fields) == 5 {
				inbound.Tag = fields[4]
			}
		}
		return "wr-nat", nil
	}
	return "wr-" + value + "-" + fields[2][:48], nil
}
