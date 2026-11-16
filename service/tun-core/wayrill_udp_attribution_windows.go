package tun

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"sync"
	"time"
)

type wayrillUDPBatchKey struct{}

type wayrillUDPQuery struct {
	address string
	query   wayrillQuery
	ctx     context.Context
	reply   chan wayrillIdentity
}

// A few independent requests share each fresh snapshot. Fixed concurrency
// bounds IPC and lets unrelated sockets progress while a batch awaits NAT.
type wayrillUDPBatcher struct {
	ctx    context.Context
	cancel context.CancelFunc
	queue  chan *wayrillUDPQuery
	worker sync.WaitGroup
}

func newWayrillUDPBatcher() *wayrillUDPBatcher {
	ctx, cancel := context.WithCancel(context.Background())
	b := &wayrillUDPBatcher{
		ctx: ctx, cancel: cancel, queue: make(chan *wayrillUDPQuery, wayrillUDPPendingLimit),
	}
	for range 4 {
		b.worker.Go(b.run)
	}
	return b
}

func (b *wayrillUDPBatcher) close() {
	b.cancel()
	b.worker.Wait()
}

func (b *wayrillUDPBatcher) lookup(ctx context.Context, address string, query wayrillQuery) (wayrillIdentity, error) {
	ctx, cancel := context.WithTimeout(ctx, 1800*time.Millisecond)
	defer cancel()
	request := &wayrillUDPQuery{address, query, ctx, make(chan wayrillIdentity, 1)}
	select {
	case b.queue <- request:
	case <-ctx.Done():
		return wayrillIdentity{}, ctx.Err()
	case <-b.ctx.Done():
		return wayrillIdentity{}, b.ctx.Err()
	}
	select {
	case result, ok := <-request.reply:
		if !ok {
			return wayrillIdentity{}, fmt.Errorf("no verified UDP owner")
		}
		return result, ctx.Err()
	case <-ctx.Done():
		return wayrillIdentity{}, ctx.Err()
	case <-b.ctx.Done():
		return wayrillIdentity{}, b.ctx.Err()
	}
}

const wayrillUDPBatchLimit = 512

func (b *wayrillUDPBatcher) run() {
	queries := make([]*wayrillUDPQuery, 0, wayrillUDPBatchLimit)
	for b.ctx.Err() == nil {
		select {
		case first := <-b.queue:
			queries = append(queries, first)
		case <-b.ctx.Done():
			return
		}
		timer := time.NewTimer(time.Millisecond)
	gather:
		for len(queries) < cap(queries) {
			select {
			case next := <-b.queue:
				queries = append(queries, next)
			case <-timer.C:
				break gather
			case <-b.ctx.Done():
				timer.Stop()
				return
			}
		}
		timer.Stop()
		b.exchange(queries)
		for _, q := range queries {
			close(q.reply)
		}
		clear(queries)
		queries = queries[:0]
	}
}

func (b *wayrillUDPBatcher) exchange(queries []*wayrillUDPQuery) {
	first := queries[0]
	request := struct {
		Auth string   `json:"auth"`
		UDP  [][4]any `json:"udp"`
	}{Auth: first.query.Auth}
	active := make([]*wayrillUDPQuery, 0, len(queries))
	for _, q := range queries {
		if q.ctx.Err() == nil && q.address == first.address && q.query.Auth == first.query.Auth {
			active = append(active, q)
			request.UDP = append(request.UDP, [4]any{q.query.Source, q.query.SourcePort, q.query.Destination, q.query.DestinationPort})
		}
	}
	if len(active) == 0 {
		return
	}
	// Close unanswered result channels on EOF or error. No failed query can
	// acquire an unmatched identity, and valid results progress immediately.
	_ = wayrillAttributionExchange(b.ctx, first.address, request, func(reader *bufio.Reader) error {
		for range active {
			var reply struct {
				Index    *int            `json:"index"`
				Identity wayrillIdentity `json:"identity"`
			}
			if err := readWayrillIdentity(reader, &reply); err != nil {
				if err == io.EOF {
					return nil
				}
				return err
			}
			if reply.Index == nil || *reply.Index < 0 || *reply.Index >= len(active) || active[*reply.Index] == nil {
				return fmt.Errorf("invalid TUN UDP identity index")
			}
			active[*reply.Index].reply <- reply.Identity
			active[*reply.Index] = nil
		}
		return nil
	})
}
