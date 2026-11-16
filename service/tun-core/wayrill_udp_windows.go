package tun

import (
	"context"
	"io"
	"strings"
	"sync"
	"time"

	"github.com/xtls/xray-core/common/buf"
	"github.com/xtls/xray-core/common/net"
	"github.com/xtls/xray-core/common/session"
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
}

type wayrillUDPFlow struct {
	key     udpFlowKey
	cone    udpConeKey
	aliases []udpFlowKey
	cancel  context.CancelFunc
	pending bool
}

const (
	wayrillUDPFlowLimit    = 16384
	wayrillUDPPendingLimit = 4096
	wayrillUDPPendingQueue = 128
)

type wayrillUDPFlows struct {
	mu          sync.RWMutex
	flows       map[udpFlowKey]*udpConn
	cones       map[udpConeKey]*udpConn
	epoch       uint64
	pending     int
	closed      bool
	attribution *wayrillUDPBatcher
}

func newWayrillUDPFlows() *wayrillUDPFlows {
	return &wayrillUDPFlows{
		flows:       make(map[udpFlowKey]*udpConn),
		cones:       make(map[udpConeKey]*udpConn),
		epoch:       session.WayrillUDPEpoch(),
		attribution: newWayrillUDPBatcher(),
	}
}

func (u *wayrillUDPFlows) packet(h *udpConnectionHandler, src, dst net.Destination, b *buf.Buffer) {
	key := udpFlowKey{src, dst}
	u.mu.RLock()
	if c := u.flows[key]; c != nil && u.epoch == session.WayrillUDPEpoch() {
		if !c.queue.push(b) {
			b.Release()
		}
		u.mu.RUnlock()
		return
	}
	u.mu.RUnlock()

	u.mu.Lock()
	defer u.mu.Unlock()
	if !u.closed {
		if epoch := session.WayrillUDPEpoch(); epoch != u.epoch {
			u.clearLocked()
			u.epoch = epoch
		}
		if c := u.flows[key]; c != nil {
			if !c.queue.push(b) {
				b.Release()
			}
			return
		}
		if len(u.flows) < wayrillUDPFlowLimit && u.pending < wayrillUDPPendingLimit {
			c := &udpConn{handler: h, src: src, dst: dst, queue: newPacketQueue(wayrillUDPPendingQueue),
				wayrill: &wayrillUDPFlow{key: key, pending: true}}
			c.queue.push(b)
			u.flows[key] = c
			u.pending++
			go h.handleConnection(c, dst)
			return
		}
	}
	b.Release()
}

func (u *wayrillUDPFlows) track(c *udpConn, cancel context.CancelFunc) bool {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.flows[c.wayrill.key] != c || u.epoch != session.WayrillUDPEpoch() {
		return false
	}
	c.wayrill.cancel = cancel
	return true
}

// settle runs after Xray's real dispatch decision, with its sniffing and
// Wayrill's attribution already applied. A shared link may carry raw datagrams
// only: rewritten targets need their own reply mapping, and policy relays can
// select a different concrete member in the main core for each new destination.
func (u *wayrillUDPFlows) settle(c *udpConn, ctx context.Context, rule string) bool {
	u.mu.Lock()
	defer u.mu.Unlock()
	f := c.wayrill
	if u.flows[f.key] != c || u.epoch != session.WayrillUDPEpoch() || ctx.Err() != nil {
		return false
	}
	u.pending--
	f.pending = false
	c.queue.mu.Lock()
	c.queue.limit = udpQueueLimit
	c.queue.mu.Unlock()
	in := session.InboundFromContext(ctx)
	out := session.OutboundsFromContext(ctx)
	ob := out[len(out)-1]
	if ob.Target != ob.OriginalTarget || strings.HasPrefix(ob.Tag, session.WayrillRelayTagPrefix) {
		return true
	}
	if in.WayrillUDPOwner.PID == 0 && in.User.Email != "wr-nat" && in.User.Email != "wr-ics6" && in.User.Email != "" {
		// An unresolved/ambiguous local owner must never join a known session.
		return true
	}
	key := udpConeKey{c.src, in.Source, in.Tag, in.User.Email, in.WayrillUDPOwner, rule, ob.Tag}
	if active := u.cones[key]; active != nil {
		c.queue.moveWayrillPackets(active.queue)
		u.flows[f.key] = active
		active.wayrill.aliases = append(active.wayrill.aliases, f.key)
		return false
	}
	f.cone = key
	u.cones[key] = c
	return true
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
	for _, alias := range f.aliases {
		delete(u.flows, alias)
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
		if to == nil || !to.push(packet) {
			packet.Release()
		}
	}
}
