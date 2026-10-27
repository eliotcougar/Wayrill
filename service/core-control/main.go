package main

// This command is copied into the pinned private worker's main package. It is
// a bounded client for the existing commander gRPC services, never a listener.
import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"time"

	command "github.com/xtls/xray-core/app/router/command"
	"github.com/xtls/xray-core/common/serial"
	"github.com/xtls/xray-core/infra/conf"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/protobuf/proto"
)

const controlLimit = 64 * 1024 * 1024

var routingLimit = errors.New("routing protobuf exceeds pinned server limit")

type controlRequest struct {
	Previous *conf.RouterConfig `json:"previous"`
	Prepare  bool               `json:"prepare"`
	Address  string             `json:"address"`
	Password string             `json:"password"`
	Routing  *conf.RouterConfig `json:"routing"`
}

func controlDial(ctx context.Context, address, password string) (net.Conn, error) {
	c, err := (&net.Dialer{}).DialContext(ctx, "tcp", address)
	if err != nil {
		return nil, err
	}
	success := false
	defer func() {
		if !success {
			c.Close()
		}
	}()
	deadline, _ := ctx.Deadline()
	c.SetDeadline(deadline)
	write := func(b []byte) error {
		for len(b) > 0 {
			n, e := c.Write(b)
			if e != nil {
				return e
			}
			if n == 0 {
				return io.ErrShortWrite
			}
			b = b[n:]
		}
		return nil
	}
	pair := make([]byte, 2)
	if err = write([]byte{5, 1, 2}); err != nil {
		return nil, err
	}
	if _, err = io.ReadFull(c, pair); err != nil || pair[0] != 5 || pair[1] != 2 {
		return nil, errors.New("authentication required")
	}
	auth := append([]byte{1, 7}, []byte("wayrill")...)
	auth = append(auth, byte(len(password)))
	auth = append(auth, []byte(password)...)
	if err = write(auth); err != nil {
		return nil, err
	}
	if _, err = io.ReadFull(c, pair); err != nil || pair[0] != 1 || pair[1] != 0 {
		return nil, errors.New("authentication failed")
	}
	host := []byte("wayrill-control.internal")
	req := append([]byte{5, 1, 0, 3, byte(len(host))}, host...)
	req = append(req, 0, 80)
	if err = write(req); err != nil {
		return nil, err
	}
	header := make([]byte, 4)
	if _, err = io.ReadFull(c, header); err != nil || header[0] != 5 || header[1] != 0 || header[2] != 0 {
		return nil, errors.New("control route unavailable")
	}
	size := 0
	switch header[3] {
	case 1:
		size = 4
	case 4:
		size = 16
	case 3:
		var n [1]byte
		if _, err = io.ReadFull(c, n[:]); err != nil {
			return nil, err
		}
		size = int(n[0])
	default:
		return nil, errors.New("invalid SOCKS response")
	}
	if _, err = io.ReadFull(c, make([]byte, size+2)); err != nil {
		return nil, err
	}
	c.SetDeadline(time.Time{})
	success = true
	return c, nil
}
func controlRun(input io.Reader) error {
	data, err := io.ReadAll(io.LimitReader(input, controlLimit+1))
	if err != nil || len(data) > controlLimit {
		return errors.New("invalid request size")
	}
	var request controlRequest
	if err = json.Unmarshal(data, &request); err != nil {
		return err
	}
	address, err := netip.ParseAddrPort(request.Address)
	if err != nil || address.Port() == 0 || address.Addr() != netip.MustParseAddr("127.0.0.1") {
		return errors.New("invalid endpoint")
	}
	if _, err = hex.DecodeString(request.Password); err != nil || len(request.Password) != 64 {
		return errors.New("invalid credential")
	}
	build := func(routing *conf.RouterConfig) (*command.AddRuleRequest, error) {
		if routing == nil {
			return nil, nil
		}
		config, err := routing.Build()
		if err != nil {
			return nil, err
		}
		update := &command.AddRuleRequest{Config: serial.ToTypedMessage(config), ShouldAppend: false}
		if proto.Size(update) > 4*1024*1024 {
			return nil, routingLimit
		}
		return update, nil
	}
	update, err := build(request.Routing)
	if err != nil {
		return err
	}
	// A cutover must also be reversible through the same pinned API limit.
	if request.Prepare {
		if _, err = build(request.Previous); err != nil {
			return err
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, err := grpc.DialContext(ctx, "passthrough:///wayrill-control", grpc.WithBlock(), grpc.WithTransportCredentials(insecure.NewCredentials()), grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
		return controlDial(ctx, request.Address, request.Password)
	}), grpc.WithDefaultCallOptions(grpc.MaxCallSendMsgSize(controlLimit), grpc.MaxCallRecvMsgSize(controlLimit)))
	if err != nil {
		return err
	}
	defer conn.Close()
	client := command.NewRoutingServiceClient(conn)
	if update != nil && !request.Prepare {
		if _, err = client.AddRule(ctx, update); err != nil {
			return err
		}
	}
	_, err = client.ListRule(ctx, &command.ListRuleRequest{})
	return err
}
func init() {
	if len(os.Args) != 2 || os.Args[1] != "wayrill-control" {
		return
	}
	if err := controlRun(os.Stdin); err != nil {
		fmt.Fprintln(os.Stderr, "Wayrill core control failed.")
		if errors.Is(err, routingLimit) {
			os.Exit(2)
		}
		os.Exit(1)
	}
	fmt.Println(`{"ok":true}`)
	os.Exit(0)
}
