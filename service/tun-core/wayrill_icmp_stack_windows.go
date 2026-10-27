//go:build windows

package tun

import (
	"bytes"
	"encoding/binary"
)

// Only the service's real TUN Handler enables native echo forwarding. The
// upstream stack's outbound-only users retain their ordinary ICMP/PMTU path.
func (s *stack) wayrillEcho(raw []byte, p packet) bool {
	if p.proto != protoICMPv4 && p.proto != protoICMPv6 {
		return false
	}
	if p.fragment || len(p.payload) < 8 || p.src.Is4() != (p.proto == protoICMPv4) {
		return true
	}
	kind := byte(8)
	if p.proto == protoICMPv6 {
		kind = 128
	}
	if p.payload[0] != kind {
		return false
	}
	if p.payload[1] != 0 || !p.verified() {
		return true
	}
	r := wayrillEchoRequest{family: 4, src: p.src, dst: p.dst}
	if p.src.Is4() {
		if raw[0] != 0x45 || checksum(sum(raw[:ipv4HeaderSize], 0)) != 0 {
			return true // IP options/source routing are not forwarded.
		}
		r.ttl, r.tos = raw[8], raw[1]
		if raw[6]&0x40 != 0 {
			r.flags = 2
		}
		r.quote = bytes.Clone(raw[:ipv4HeaderSize+len(p.payload)])
	} else {
		r.family, r.ttl = 6, raw[7]
		length := ipv6HeaderSize + int(binary.BigEndian.Uint16(raw[4:]))
		next, offset := raw[6], ipv6HeaderSize
		for steps := 0; next != protoICMPv6; steps++ {
			if steps >= 8 || (next != 0 && next != 60) || offset+8 > length {
				return true // No routed or fragmented echo may get a local reply.
			}
			size := (int(raw[offset+1]) + 1) * 8
			if offset+size > length {
				return true
			}
			next, offset = raw[offset], offset+size
		}
		r.quote = bytes.Clone(raw[:length])
	}
	r.message = bytes.Clone(p.payload)
	s.icmp.forward(r, func(response wayrillEchoResponse) {
		message := wayrillICMPMessage(r, response)
		if message == nil {
			return
		}
		var header [ipv6HeaderSize]byte
		n := putIPHeader(header[:], p.proto, response.address, r.src)
		message[2], message[3] = 0, 0
		if r.family == 4 {
			header[8] = response.ttl
			binary.BigEndian.PutUint16(message[2:], checksum(sum(message, 0)))
		} else {
			header[7] = response.ttl
			binary.BigEndian.PutUint16(message[2:], transportChecksum(header[:n], protoICMPv6, message, nil))
		}
		_ = s.write(header[:n], message)
	})
	return true
}

// Only actual native responses produce a packet. Errors quote the original
// request, including its original source, identifier, sequence and payload.
func wayrillICMPMessage(r wayrillEchoRequest, response wayrillEchoResponse) []byte {
	if response.status == 0 {
		message := append(bytes.Clone(r.message[:8]), response.payload...)
		message[0] = 0
		if r.family == 6 {
			message[0] = 129
		}
		return message
	}
	kind, code := byte(0), byte(0)
	if r.family == 4 {
		switch response.status {
		case 11002, 11003, 11004, 11005:
			kind, code = 3, byte(response.status-11002)
		case 11009:
			kind, code = 3, 4
		case 11013, 11014:
			kind, code = 11, byte(response.status-11013)
		default:
			return nil
		}
	} else {
		switch response.status {
		case 11002, 11040:
			kind, code = 1, 0
		case 11003:
			kind, code = 1, 3
		case 11004:
			kind, code = 1, 1
		case 11005:
			kind, code = 1, 4
		case 11013, 11014:
			kind, code = 3, byte(response.status-11013)
		case 11041:
			kind, code = 3, 0
		default:
			return nil
		}
	}
	maximum := ipv4HeaderSize + 8
	if r.family == 6 {
		maximum = 1232
	}
	quote := r.quote[:min(len(r.quote), maximum)]
	message := make([]byte, 8+len(quote))
	message[0], message[1] = kind, code
	copy(message[8:], quote)
	return message
}
