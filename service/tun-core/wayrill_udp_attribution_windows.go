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
	reply   chan wayrillUDPResult
}

type wayrillUDPResult struct {
	Index    *int             `json:"index"`
	Identity *wayrillIdentity `json:"identity,omitempty"`
	Pending  bool             `json:"pending,omitempty"`
}

// First observations and retries have independent, bounded IPC capacity.
type wayrillUDPBatcher struct {
	ctx     context.Context
	cancel  context.CancelFunc
	queue   chan *wayrillUDPQuery
	retries chan *wayrillUDPQuery
	worker  sync.WaitGroup
}

func newWayrillUDPBatcher() *wayrillUDPBatcher {
	ctx, cancel := context.WithCancel(context.Background())
	b := &wayrillUDPBatcher{
		ctx: ctx, cancel: cancel, queue: make(chan *wayrillUDPQuery, wayrillUDPPendingLimit),
		retries: make(chan *wayrillUDPQuery, wayrillUDPPendingLimit),
	}
	for range 4 {
		b.worker.Go(func() { b.run(b.queue, true) })
		b.worker.Go(func() { b.run(b.retries, false) })
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
	for _, queue := range []chan *wayrillUDPQuery{b.queue, b.retries} {
		request := &wayrillUDPQuery{address, query, ctx, make(chan wayrillUDPResult, 1)}
		select {
		case queue <- request:
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
			if result.Identity != nil {
				return *result.Identity, ctx.Err()
			}
		case <-ctx.Done():
			return wayrillIdentity{}, ctx.Err()
		case <-b.ctx.Done():
			return wayrillIdentity{}, b.ctx.Err()
		}
	}
	return wayrillIdentity{}, fmt.Errorf("no verified UDP owner")
}

const wayrillUDPBatchLimit = 512

func (b *wayrillUDPBatcher) run(queue <-chan *wayrillUDPQuery, firstPass bool) {
	queries := make([]*wayrillUDPQuery, 0, wayrillUDPBatchLimit)
	for b.ctx.Err() == nil {
		select {
		case first := <-queue:
			queries = append(queries, first)
		case <-b.ctx.Done():
			return
		}
		timer := time.NewTimer(time.Millisecond)
	gather:
		for len(queries) < cap(queries) {
			select {
			case next := <-queue:
				queries = append(queries, next)
			case <-timer.C:
				break gather
			case <-b.ctx.Done():
				timer.Stop()
				return
			}
		}
		timer.Stop()
		b.exchange(queries, firstPass)
		for _, q := range queries {
			close(q.reply)
		}
		clear(queries)
		queries = queries[:0]
	}
}

func (b *wayrillUDPBatcher) exchange(queries []*wayrillUDPQuery, firstPass bool) {
	first := queries[0]
	request := struct {
		Auth      string   `json:"auth"`
		UDP       [][4]any `json:"udp"`
		FirstPass bool     `json:"firstPass,omitempty"`
	}{Auth: first.query.Auth, FirstPass: firstPass}
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
			var reply wayrillUDPResult
			if err := readWayrillIdentity(reader, &reply); err != nil {
				if err == io.EOF {
					return nil
				}
				return err
			}
			if reply.Index == nil || *reply.Index < 0 || *reply.Index >= len(active) || active[*reply.Index] == nil {
				return fmt.Errorf("invalid TUN UDP identity index")
			}
			if (reply.Identity != nil) == reply.Pending || (reply.Pending && !firstPass) {
				return fmt.Errorf("invalid TUN UDP identity result")
			}
			active[*reply.Index].reply <- reply
			active[*reply.Index] = nil
		}
		return nil
	})
}
