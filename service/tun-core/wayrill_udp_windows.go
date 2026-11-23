package tun

import (
	"container/list"
	"context"
	"errors"
	"io"
	"sync"
	"sync/atomic"
	"time"

	"github.com/xtls/xray-core/common/buf"
	"github.com/xtls/xray-core/common/net"
	"github.com/xtls/xray-core/common/session"
	"github.com/xtls/xray-core/features/stats"
	"golang.org/x/sys/windows"
)

type udpFlowKey struct {
	src net.Destination
	dst net.Destination
}

// Even a valid route cannot share a socket across process generations, NAT
// origins, or different process masks from the attribution companion.
type udpConeKey struct {
	wire, origin net.Destination
	inbound      string
	user         string
	owner        session.WayrillUDPOwner
	rule         string
	outbound     string
	family       net.AddressFamily
}

type wayrillUDPFlow struct {
	key     udpFlowKey
	cone    udpConeKey
	aliases map[*list.Element]struct{}
	cancel  context.CancelFunc
	pending bool
	binding wayrillUDPBinding
	created time.Time
	replies *wayrillUDPReplyStats
}

type wayrillUDPReplyStats struct {
	downlink, ownership, ringFull stats.Counter
}

type wayrillUDPAlias struct {
	key     udpFlowKey
	conn    *udpConn
	expires time.Time
	binding wayrillUDPBinding
}

type wayrillUDPBinding struct {
	origin  net.Destination
	owner   session.WayrillUDPOwner
	user    string
	until   time.Time
	refresh *wayrillUDPRefresh
}

type wayrillUDPRefresh struct {
	queue  *packetQueue
	cancel context.CancelFunc
	done   chan struct{}
}

const (
	wayrillUDPFlowLimit  = 16384
	wayrillUDPAliasLimit = 16384
	wayrillUDPAliasTTL   = time.Minute
	// Native UDP ownership is sampled. A continuously active flow must not
	// keep an old process identity alive indefinitely after an endpoint rebind.
	wayrillUDPOwnerTTL     = 2 * time.Second
	wayrillUDPVerifyAhead  = 250 * time.Millisecond
	wayrillUDPPendingLimit = 4096
	wayrillUDPPendingQueue = 128
)

type wayrillUDPFlows struct {
	mu          sync.RWMutex
	flows       map[udpFlowKey]*udpConn
	aliases     map[udpFlowKey]*list.Element
	aliasOrder  list.List
	cones       map[udpConeKey]*udpConn
	epoch       uint64
	pending     int
	queuedBytes atomic.Int64
	closed      bool
	attribution *wayrillUDPBatcher
}

func newWayrillUDPFlows() *wayrillUDPFlows {
	return &wayrillUDPFlows{
		flows:       make(map[udpFlowKey]*udpConn),
		aliases:     make(map[udpFlowKey]*list.Element),
		cones:       make(map[udpConeKey]*udpConn),
		epoch:       session.WayrillUDPEpoch(),
		attribution: newWayrillUDPBatcher(),
	}
}

// A cache hit never extends the verified route's lifetime or mutates the FIFO.
func (u *wayrillUDPFlows) lookupLocked(key udpFlowKey, now time.Time) (*udpConn, *wayrillUDPBinding) {
	if c := u.flows[key]; c != nil {
		return c, &c.wayrill.binding
	}
	if entry := u.aliases[key]; entry != nil {
		alias := entry.Value.(*wayrillUDPAlias)
		if now.Before(alias.expires) {
			return alias.conn, &alias.binding
		}
	}
	return nil, nil
}

func (u *wayrillUDPFlows) packet(h *udpConnectionHandler, src, dst net.Destination, b *buf.Buffer) {
	key := udpFlowKey{src, dst}
	u.mu.RLock()
	now := time.Now()
	if c, binding := u.lookupLocked(key, now); c != nil && u.epoch == session.WayrillUDPEpoch() &&
		(binding.until.IsZero() || binding.until.Sub(now) > wayrillUDPVerifyAhead ||
			(binding.refresh != nil && now.Before(binding.until))) {
		pushWayrillPacket(c.queue, b)
		u.mu.RUnlock()
		return
	}
	u.mu.RUnlock()

	u.mu.Lock()
	defer u.mu.Unlock()
	if !u.closed {
		now := time.Now()
		if epoch := session.WayrillUDPEpoch(); epoch != u.epoch {
			u.clearLocked()
			u.epoch = epoch
		}
		if c, binding := u.lookupLocked(key, now); c != nil {
			remaining := binding.until.Sub(now)
			if binding.until.IsZero() || remaining > 0 {
				if !binding.until.IsZero() && remaining <= wayrillUDPVerifyAhead {
					u.refreshLocked(c, key, binding)
				}
				pushWayrillPacket(c.queue, b)
			} else if refresh := u.refreshLocked(c, key, binding); refresh != nil {
				pushWayrillPacket(refresh.queue, b)
			} else {
				b.Release()
			}
			return
		}
		if len(u.flows) < wayrillUDPFlowLimit && u.pending < wayrillUDPPendingLimit {
			if entry := u.aliases[key]; entry != nil {
				u.removeAliasLocked(entry)
			}
			queue := u.newPendingQueue()
			if !queue.push(b) {
				b.Release()
				return
			}
			u.startLocked(h, key, queue)
			return
		}
	}
	b.Release()
}

func pushWayrillPacket(queue *packetQueue, b *buf.Buffer) {
	if !queue.push(b) {
		b.Release()
	}
}

func (u *wayrillUDPFlows) newPendingQueue() *packetQueue {
	queue := newPacketQueue(wayrillUDPPendingQueue)
	queue.budget = &u.queuedBytes
	return queue
}

func (u *wayrillUDPFlows) startLocked(h *udpConnectionHandler, key udpFlowKey, queue *packetQueue) {
	c := &udpConn{handler: h, src: key.src, dst: key.dst, queue: queue,
		wayrill: &wayrillUDPFlow{key: key, pending: true, created: time.Now()}}
	u.flows[key] = c
	u.pending++
	go h.handleConnection(c, key.dst)
}

func (u *wayrillUDPFlows) refreshLocked(c *udpConn, key udpFlowKey, binding *wayrillUDPBinding) *wayrillUDPRefresh {
	if refresh := binding.refresh; refresh != nil {
		return refresh
	}
	if u.pending >= wayrillUDPPendingLimit {
		return nil
	}
	ctx := context.WithValue(u.attribution.ctx, wayrillUDPBatchKey{}, u.attribution)
	ctx, cancel := context.WithCancel(ctx)
	refresh := &wayrillUDPRefresh{u.newPendingQueue(), cancel, make(chan struct{})}
	binding.refresh = refresh
	u.pending++
	go u.verify(ctx, c, key, binding, refresh)
	return refresh
}

func (u *wayrillUDPFlows) verify(ctx context.Context, c *udpConn, key udpFlowKey, binding *wayrillUDPBinding, refresh *wayrillUDPRefresh) {
	in := session.Inbound{Source: key.src}
	observed := time.Now()
	user, err := wayrillProcessIdentity(ctx, key.src, key.dst, &in)
	u.mu.Lock()
	defer u.mu.Unlock()
	if binding.refresh != refresh {
		return
	}
	u.stopVerificationLocked(binding)
	if !u.activeLocked(c) {
		refresh.queue.moveWayrillPackets(nil)
		return
	}
	if err != nil {
		// Suspend forwarding until a fresh observation succeeds. A transient
		// IPC failure is not evidence that the underlying socket changed.
		stopAt := binding.until.Add(wayrillUDPOwnerTTL)
		if observed.After(stopAt) {
			u.retireBindingLocked(c, key, binding)
		} else if observed.Before(binding.until) {
			binding.until = observed
		}
		refresh.queue.moveWayrillPackets(nil)
		return
	}
	if binding.user != user || binding.origin != in.Source || binding.owner != in.WayrillUDPOwner {
		// Packets held for the old lease cannot be attributed to the new owner.
		refresh.queue.moveWayrillPackets(nil)
		u.retireBindingLocked(c, key, binding)
		return
	}
	binding.until = observed.Add(wayrillUDPOwnerTTL)
	refresh.queue.moveWayrillPackets(c.queue)
}

func (u *wayrillUDPFlows) retireBindingLocked(c *udpConn, key udpFlowKey, binding *wayrillUDPBinding) {
	if binding.user == "wr-nat" && key != c.wayrill.key {
		// NAT origin evidence is specific to this translated destination.
		u.removeAliasLocked(u.aliases[key])
		return
	}
	u.removeLocked(c)
}

func (u *wayrillUDPFlows) stopVerificationLocked(binding *wayrillUDPBinding) *wayrillUDPRefresh {
	refresh := binding.refresh
	if refresh == nil {
		return nil
	}
	binding.refresh = nil
	refresh.cancel()
	close(refresh.done)
	u.pending--
	return refresh
}

func (u *wayrillUDPFlows) activeLocked(c *udpConn) bool {
	return u.flows[c.wayrill.key] == c && u.epoch == session.WayrillUDPEpoch()
}

func (c *udpConn) readPacket() (*buf.Buffer, bool) {
	if c.wayrill == nil {
		return c.queue.pop()
	}
	flows := c.handler.wayrill
	for {
		b, ok := c.queue.pop()
		if !ok {
			return nil, false
		}
		flows.mu.RLock()
		active := flows.activeLocked(c)
		var permitted bool
		if active && !c.wayrill.pending && b.UDP != nil {
			now := time.Now()
			owner, binding := flows.lookupLocked(udpFlowKey{c.src, *b.UDP}, now)
			permitted = owner == c && binding.ownerState(now) == udpOwnerVerified
		}
		flows.mu.RUnlock()
		if permitted {
			return b, true
		}
		b.Release()
		if !active {
			return nil, false
		}
	}
}

func (u *wayrillUDPFlows) reply(c *udpConn, p []byte, peer net.Destination) error {
	if done, err := u.tryReply(c, p, peer); done || err != nil {
		return err
	}
	u.mu.Lock()
	var refresh *wayrillUDPRefresh
	if u.activeLocked(c) {
		now := time.Now()
		key, binding := u.replyBindingLocked(c, peer, now)
		if binding != nil && !binding.valid(now) {
			refresh = u.refreshLocked(c, key, binding)
		}
	}
	u.mu.Unlock()
	if refresh != nil {
		// A single downlink reader owns p. Wait outside both table locks and
		// verify again because the lookup may have retired the whole flow.
		<-refresh.done
	}
	done, err := u.tryReply(c, p, peer)
	if !done && err == nil {
		c.wayrill.replies.dropOwnership()
	}
	return err
}

func (s *wayrillUDPReplyStats) dropOwnership() {
	if s != nil && s.ownership != nil {
		s.ownership.Add(1)
	}
}

func (u *wayrillUDPFlows) replyBindingLocked(c *udpConn, peer net.Destination, now time.Time) (udpFlowKey, *wayrillUDPBinding) {
	key := udpFlowKey{c.src, peer}
	if key == c.wayrill.key {
		return key, &c.wayrill.binding
	}
	if found, binding := u.lookupLocked(key, now); found == c {
		return key, binding
	}
	if c.wayrill.binding.user == "wr-nat" {
		// Proof for one translated destination does not authorize a reply from
		// another. An evicted NAT alias must be matched again on the uplink.
		return key, nil
	}
	return c.wayrill.key, &c.wayrill.binding
}

type udpOwnerState uint8

const (
	udpOwnerVerified udpOwnerState = iota
	udpOwnerExpired
	udpOwnerVerifying
)

func (b *wayrillUDPBinding) ownerState(now time.Time) udpOwnerState {
	// An inbound without native ownership requirements never needs a refresh.
	if b.until.IsZero() || now.Before(b.until) {
		return udpOwnerVerified
	}
	if b.refresh != nil {
		return udpOwnerVerifying
	}
	return udpOwnerExpired
}

func (b *wayrillUDPBinding) valid(now time.Time) bool {
	return b.ownerState(now) == udpOwnerVerified
}

func (u *wayrillUDPFlows) tryReply(c *udpConn, p []byte, peer net.Destination) (bool, error) {
	u.mu.RLock()
	defer u.mu.RUnlock()
	if !u.activeLocked(c) {
		return false, context.Canceled
	}
	now := time.Now()
	_, binding := u.replyBindingLocked(c, peer, now)
	if binding == nil {
		c.wayrill.replies.dropOwnership()
		return true, nil
	}
	if !binding.valid(now) {
		return false, nil
	}
	return true, session.WithWayrillUDPReply(u.epoch, func() error {
		err := c.handler.writePacket(p, peer, c.src)
		counters := c.wayrill.replies
		if err != nil {
			if errors.Is(err, windows.ERROR_BUFFER_OVERFLOW) {
				if counters != nil && counters.ringFull != nil {
					counters.ringFull.Add(1)
				}
				return nil
			}
			return err
		}
		if counters != nil && counters.downlink != nil {
			counters.downlink.Add(int64(len(p)))
		}
		return nil
	})
}

func (u *wayrillUDPFlows) track(c *udpConn, cancel context.CancelFunc) bool {
	u.mu.Lock()
	defer u.mu.Unlock()
	if !u.activeLocked(c) {
		return false
	}
	c.wayrill.cancel = cancel
	return true
}

// settle runs after Xray's real dispatch decision, with its sniffing and
// Wayrill's attribution already applied. Only an outbound that preserves
// per-packet endpoints can share, and rewritten targets need their own reply mapping.
func (u *wayrillUDPFlows) settle(c *udpConn, ctx context.Context, rule string, shareable bool) bool {
	u.mu.Lock()
	defer u.mu.Unlock()
	f := c.wayrill
	if !u.activeLocked(c) || ctx.Err() != nil {
		return false
	}
	u.pending--
	f.pending = false
	c.queue.mu.Lock()
	c.queue.limit = udpQueueLimit
	c.queue.mu.Unlock()
	in := session.InboundFromContext(ctx)
	if in != nil && in.User != nil && in.User.Email != "" && in.User.Email != "wr-ics6" {
		f.binding = wayrillUDPBinding{origin: in.Source, owner: in.WayrillUDPOwner,
			user: in.User.Email, until: f.created.Add(wayrillUDPOwnerTTL)}
	}
	out := session.OutboundsFromContext(ctx)
	ob := out[len(out)-1]
	if !shareable || ob.Target != ob.OriginalTarget || !ob.Target.Address.Family().IsIP() {
		return true
	}
	if in.WayrillUDPOwner.PID == 0 && in.User.Email != "wr-nat" && in.User.Email != "wr-ics6" && in.User.Email != "" {
		// An unresolved/ambiguous local owner must never join a known session.
		return true
	}
	key := udpConeKey{c.src, in.Source, in.Tag, in.User.Email, in.WayrillUDPOwner, rule, ob.Tag, ob.Target.Address.Family()}
	if active := u.cones[key]; active != nil {
		c.queue.moveWayrillPackets(active.queue)
		delete(u.flows, f.key)
		u.addAliasLocked(f.key, active, f.binding)
		return false
	}
	f.cone = key
	u.cones[key] = c
	return true
}

func (u *wayrillUDPFlows) addAliasLocked(key udpFlowKey, conn *udpConn, binding wayrillUDPBinding) {
	now := time.Now()
	for u.aliasOrder.Len() > 0 {
		oldest := u.aliasOrder.Front()
		if len(u.aliases) < wayrillUDPAliasLimit && now.Before(oldest.Value.(*wayrillUDPAlias).expires) {
			break
		}
		u.removeAliasLocked(oldest)
	}
	entry := u.aliasOrder.PushBack(&wayrillUDPAlias{key, conn, now.Add(wayrillUDPAliasTTL), binding})
	u.aliases[key] = entry
	if conn.wayrill.aliases == nil {
		conn.wayrill.aliases = make(map[*list.Element]struct{})
	}
	conn.wayrill.aliases[entry] = struct{}{}
}

func (u *wayrillUDPFlows) removeAliasLocked(entry *list.Element) {
	alias := entry.Value.(*wayrillUDPAlias)
	if refresh := u.stopVerificationLocked(&alias.binding); refresh != nil {
		refresh.queue.moveWayrillPackets(nil)
	}
	delete(u.aliases, alias.key)
	delete(alias.conn.wayrill.aliases, entry)
	u.aliasOrder.Remove(entry)
}

func (u *wayrillUDPFlows) finish(c *udpConn) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.removeLocked(c)
}

func (u *wayrillUDPFlows) removeLocked(c *udpConn) {
	f := c.wayrill
	if u.flows[f.key] != c {
		return
	}
	delete(u.flows, f.key)
	if refresh := u.stopVerificationLocked(&f.binding); refresh != nil {
		refresh.queue.moveWayrillPackets(nil)
	}
	for entry := range f.aliases {
		u.removeAliasLocked(entry)
	}
	if u.cones[f.cone] == c {
		delete(u.cones, f.cone)
	}
	if f.pending {
		u.pending--
	}
	if f.cancel != nil {
		f.cancel()
	}
	c.queue.moveWayrillPackets(nil)
}

func (u *wayrillUDPFlows) clearLocked() {
	for _, c := range u.flows {
		u.removeLocked(c)
	}
}

func (u *wayrillUDPFlows) close() {
	u.mu.Lock()
	u.closed = true
	u.clearLocked()
	u.mu.Unlock()
	u.attribution.close()
}

// Sniff without popping. This avoids moving bytes held by a reader or counting
// them twice when the normal dispatcher joins an existing outbound queue.
func (q *packetQueue) peekWayrillPackets(dst []byte, count int, timeout time.Duration) (int, error) {
	var timer *time.Timer
	defer func() {
		if timer != nil {
			timer.Stop()
		}
	}()
	for {
		q.mu.Lock()
		if q.closed {
			q.mu.Unlock()
			return 0, io.EOF
		}
		if timeout <= 0 || len(q.items) >= count {
			n := 0
			for _, packet := range q.items[:min(count, len(q.items))] {
				n += copy(dst[n:], packet.Bytes())
				if n == len(dst) {
					break
				}
			}
			q.mu.Unlock()
			return n, nil
		}
		q.mu.Unlock()
		if timer == nil {
			timer = time.NewTimer(timeout)
		}
		select {
		case <-q.notify:
		case <-timer.C:
			timeout = 0
		}
	}
}

// No pending flow has a consumer yet. Moving its queue is atomic with changing
// the destination index, so subsequent datagrams cannot pass buffered ones.
func (q *packetQueue) moveWayrillPackets(to *packetQueue) {
	q.mu.Lock()
	packets := q.items
	q.items = nil
	if !q.closed {
		q.closed = true
		close(q.notify)
	}
	q.mu.Unlock()
	for _, packet := range packets {
		if q.budget != nil {
			q.budget.Add(-queuedUDPBytes(packet))
		}
		if to == nil || !to.push(packet) {
			packet.Release()
		}
	}
}
