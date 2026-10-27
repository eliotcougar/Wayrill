package main

// Wayrill's executable owns these listener defaults. Keep them outside Xray's
// SOCKS implementation; ordinary inbound sockopts are applied after this hook.
import (
	"fmt"
	"os"
	"strconv"
	"syscall"

	"github.com/xtls/xray-core/transport/internet"
)

func init() {
	// Register once, before any core or listener starts. Xray's registry is
	// process-wide and has no unregister operation.
	if err := internet.RegisterListenerController(wayrillUDPBuffers); err != nil {
		fmt.Fprintln(os.Stderr, "Register Wayrill UDP listener defaults:", err)
		os.Exit(1)
	}
}

func wayrillUDPBuffers(network, _ string, c syscall.RawConn) error {
	switch network {
	case "udp", "udp4", "udp6":
	default:
		return nil
	}
	var sizes [2]int
	for i, key := range []string{"WAYRILL_UDP_LISTENER_RECEIVE_BYTES", "WAYRILL_UDP_LISTENER_SEND_BYTES"} {
		value := os.Getenv(key)
		if value == "" {
			continue
		}
		size, err := strconv.ParseUint(value, 10, 31)
		if err != nil || size > 64*1024*1024 {
			return fmt.Errorf("invalid UDP listener buffer %s", key)
		}
		sizes[i] = int(size)
	}
	if sizes == [2]int{} {
		return nil
	}
	var socketErr error
	if err := c.Control(func(fd uintptr) {
		for i, option := range []int{syscall.SO_RCVBUF, syscall.SO_SNDBUF} {
			if sizes[i] == 0 {
				continue
			}
			if err := syscall.SetsockoptInt(syscall.Handle(fd), syscall.SOL_SOCKET, option, sizes[i]); err != nil {
				socketErr = fmt.Errorf("set UDP buffer %d: %w", option, err)
				return
			}
		}
	}); err != nil {
		return err
	}
	// Xray reports controller failures in its log. A successful listener start
	// alone must not be treated as proof that Windows accepted these defaults.
	return socketErr
}
