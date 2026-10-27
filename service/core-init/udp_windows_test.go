package main

import (
	"context"
	"errors"
	"io"
	"net"
	"syscall"
	"testing"
	"time"

	xnet "github.com/xtls/xray-core/common/net"
	"github.com/xtls/xray-core/infra/conf"
	"github.com/xtls/xray-core/proxy/socks"
	"github.com/xtls/xray-core/transport/internet"
)

func listenerBuffers(t *testing.T, socket syscall.Conn) [2]int {
	t.Helper()
	raw, err := socket.SyscallConn()
	if err != nil {
		t.Fatal(err)
	}
	var values [2]int
	var socketErr error
	err = raw.Control(func(fd uintptr) {
		for i, option := range []int{syscall.SO_RCVBUF, syscall.SO_SNDBUF} {
			values[i], socketErr = syscall.GetsockoptInt(syscall.Handle(fd), syscall.SOL_SOCKET, option)
			if socketErr != nil {
				return
			}
		}
	})
	if err != nil || socketErr != nil {
		t.Fatalf("read socket buffers: %v / %v", err, socketErr)
	}
	return values
}

func TestWayrillUDPListenerDefaults(t *testing.T) {
	t.Setenv("WAYRILL_UDP_LISTENER_RECEIVE_BYTES", "393216")
	t.Setenv("WAYRILL_UDP_LISTENER_SEND_BYTES", "196608")
	for _, host := range []string{"127.0.0.1", "::1"} {
		t.Run(host, func(t *testing.T) {
			for _, override := range []bool{false, true} {
				name := "default"
				want := [2]int{393216, 196608}
				var settings *internet.SocketConfig
				if override {
					name = "explicit"
					want = [2]int{512 * 1024, 128 * 1024}
					settings = &internet.SocketConfig{CustomSockopt: []*internet.CustomSockopt{
						{System: "windows", Network: "udp", Level: "65535", Opt: "4098", Value: "524288", Type: "int"},
						{System: "windows", Network: "udp", Level: "65535", Opt: "4097", Value: "131072", Type: "int"},
					}}
				}
				t.Run(name, func(t *testing.T) {
					c, err := internet.ListenSystemPacket(context.Background(), &net.UDPAddr{IP: net.ParseIP(host)}, settings)
					if err != nil {
						t.Fatal(err)
					}
					defer c.Close()
					if got := listenerBuffers(t, c.(syscall.Conn)); got != want {
						t.Fatalf("UDP buffers = %v, want %v", got, want)
					}
				})
			}
		})
	}
}

func TestWayrillUDPListenerReadsConfigEnvironment(t *testing.T) {
	t.Setenv("WAYRILL_UDP_LISTENER_RECEIVE_BYTES", "")
	t.Setenv("WAYRILL_UDP_LISTENER_SEND_BYTES", "")
	config := &conf.Config{Env: map[string]string{
		"WAYRILL_UDP_LISTENER_RECEIVE_BYTES": "524288",
		"WAYRILL_UDP_LISTENER_SEND_BYTES":    "393216",
	}}
	if _, err := config.Build(); err != nil {
		t.Fatal(err)
	}
	listener, err := internet.ListenSystemPacket(context.Background(), &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	if got := listenerBuffers(t, listener.(syscall.Conn)); got != [2]int{524288, 393216} {
		t.Fatalf("config environment did not reach socket: %v", got)
	}
}

func TestWayrillUDPListenerSystemDefaults(t *testing.T) {
	for _, value := range []string{"", "0"} {
		t.Run(value, func(t *testing.T) {
			t.Setenv("WAYRILL_UDP_LISTENER_RECEIVE_BYTES", value)
			t.Setenv("WAYRILL_UDP_LISTENER_SEND_BYTES", value)
			baseline, err := net.ListenPacket("udp4", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer baseline.Close()
			listener, err := internet.ListenSystemPacket(context.Background(), &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)}, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			if got, want := listenerBuffers(t, listener.(syscall.Conn)), listenerBuffers(t, baseline.(syscall.Conn)); got != want {
				t.Fatalf("UDP buffers = %v, want system defaults %v", got, want)
			}
		})
	}
}

func TestWayrillUDPListenerRejectsInvalidSettingsBeforeSocketMutation(t *testing.T) {
	for _, value := range []string{"-1", "text", "67108865", "2147483648"} {
		t.Setenv("WAYRILL_UDP_LISTENER_RECEIVE_BYTES", value)
		t.Setenv("WAYRILL_UDP_LISTENER_SEND_BYTES", "1024")
		if err := wayrillUDPBuffers("udp", "", nil); err == nil {
			t.Fatal("accepted invalid buffer", value)
		}
		if err := wayrillUDPBuffers("tcp", "", nil); err != nil {
			t.Fatal("UDP settings affected TCP", err)
		}
	}
}

func TestWayrillListenerDefaultsLeaveTCPUnchanged(t *testing.T) {
	baseline, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer baseline.Close()
	c, err := internet.ListenSystem(context.Background(), &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)}, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if got, want := listenerBuffers(t, c.(syscall.Conn)), listenerBuffers(t, baseline); got != want {
		t.Fatalf("TCP buffers = %v, want system defaults %v", got, want)
	}
}

func TestWayrillUDPOutboundOverrides(t *testing.T) {
	settings := &internet.SocketConfig{CustomSockopt: []*internet.CustomSockopt{
		{System: "windows", Network: "udp", Level: "65535", Opt: "4098", Value: "524288", Type: "int"},
		{System: "windows", Network: "udp", Level: "65535", Opt: "4097", Value: "131072", Type: "int"},
	}}
	for _, host := range []string{"127.0.0.1", "::1"} {
		t.Run(host, func(t *testing.T) {
			c, err := (&internet.DefaultSystemDialer{}).Dial(context.Background(), nil, xnet.UDPDestination(xnet.ParseAddress(host), 9), settings)
			if err != nil {
				t.Fatal(err)
			}
			defer c.Close()
			if got := listenerBuffers(t, c.(*xnet.PacketConnWrapper).PacketConn.(syscall.Conn)); got != [2]int{524288, 131072} {
				t.Fatalf("outbound UDP buffers = %v, want explicit overrides", got)
			}
		})
	}
}

// A UDP socket is opened with ListenPacket, whose Control address is local.
// Dialer controllers must still receive the destination, as for TCP: the TUN
// controller uses it to keep private loopback relays off the physical uplink.
func TestWayrillUDPControllerReceivesRemoteDestination(t *testing.T) {
	previous := internet.Controllers
	defer func() { internet.Controllers = previous }()
	for _, host := range []string{"127.0.0.1", "::1"} {
		t.Run(host, func(t *testing.T) {
			dest := xnet.UDPDestination(xnet.ParseAddress(host), 18080)
			var address string
			internet.Controllers = []func(string, string, syscall.RawConn) error{
				func(_ string, remote string, _ syscall.RawConn) error {
					address = remote
					return nil
				},
			}
			conn, err := (&internet.DefaultSystemDialer{}).Dial(context.Background(), nil, dest, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			if address != dest.NetAddr() {
				t.Fatalf("controller received %q; want remote destination %q", address, dest.NetAddr())
			}
		})
	}
}

func TestWayrillUDPAssociationCloseBeforeTimeout(t *testing.T) {
	udp, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer udp.Close()
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	association := socks.NewTempUDPConn(udp, client, &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	// A failed SOCKS reply closes the association before processTCP sets the
	// configured idle timeout. The constructor timer must permit full cleanup.
	association.Close()
	if err := udp.SetReadDeadline(time.Now()); !errors.Is(err, net.ErrClosed) {
		t.Fatalf("UDP socket was not closed: %v", err)
	}
	if _, err := server.Write([]byte("closed")); !errors.Is(err, io.ErrClosedPipe) {
		t.Fatalf("TCP association was not closed: %v", err)
	}
}
