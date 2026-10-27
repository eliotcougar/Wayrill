// SPDX-License-Identifier: GPL-3.0-only
use std::net::IpAddr;
use wayrill_capture::{
    address::{Address, DivertAddress},
    batch::{self, PacketBatch},
    fragments::{FragmentBuffer, FragmentResult},
    packet::{self, Flow, Packet},
    pending::{PendingPacket, PendingPackets},
    Error,
};

fn flow(six: bool) -> Flow {
    Flow {
        protocol: 17,
        local: Address {
            ip: if six { "fd00::10" } else { "10.0.2.15" }.parse().unwrap(),
            scope: 0,
        },
        remote: Address {
            ip: if six { "2001:db8::123" } else { "203.0.113.5" }
                .parse()
                .unwrap(),
            scope: 0,
        },
        local_port: 54321,
        remote_port: 443,
    }
}
fn read_lengths(packets: &[u8], address_length: usize) -> wayrill_capture::Result<Vec<usize>> {
    let mut lengths = [0; batch::CAPACITY];
    let count = batch::read_lengths(packets, address_length, &mut lengths)?;
    Ok(lengths[..count].to_vec())
}

#[test]
fn malformed_packet_and_fragment_inputs_remain_bounded_and_never_panic() {
    let mut random = 0x6a09e667f3bcc909u64;
    let mut next = || {
        random ^= random << 13;
        random ^= random >> 7;
        random ^= random << 17;
        random
    };
    let mut fragments = FragmentBuffer::default();
    for case in 0..20_000 {
        let mut bytes = vec![0; (next() % 1024) as usize];
        for byte in &mut bytes {
            *byte = next() as u8;
        }
        if let Some(first) = bytes.first_mut() {
            *first = (*first & 15) | if case % 2 == 0 { 0x40 } else { 0x60 };
        }
        let _ = Packet::parse(&bytes, 7);
        let _ = read_lengths(&bytes, 80);
        let _ = fragments.add(&bytes, DivertAddress::default(), case, |_, _, _, _| false);
        assert!(fragments.len() <= 256);
        assert!(fragments.bytes() <= 16 * 1024 * 1024);
    }
}
fn fragment(original: &[u8], start: usize, length: usize, more: bool) -> Vec<u8> {
    let six = original[0] >> 4 == 6;
    let header = if six { 40 } else { 20 };
    let mut output = vec![0; header + if six { 8 } else { 0 } + length];
    output[..header].copy_from_slice(&original[..header]);
    if six {
        output[6] = 44;
        output[40] = original[6];
        output[42..44].copy_from_slice(&((start as u16) | u16::from(more)).to_be_bytes());
        output[44..48].copy_from_slice(&12345u32.to_be_bytes());
        output[4..6].copy_from_slice(&((length + 8) as u16).to_be_bytes());
    } else {
        output[6..8]
            .copy_from_slice(&((start as u16 / 8) | if more { 0x2000 } else { 0 }).to_be_bytes());
        output[2..4].copy_from_slice(&((header + length) as u16).to_be_bytes());
    }
    let destination = output.len() - length;
    output[destination..].copy_from_slice(&original[header + start..header + start + length]);
    output
}

#[test]
fn abi_preserves_full_union_and_high_flags() {
    assert_eq!(std::mem::size_of::<DivertAddress>(), 80);
    assert_eq!(std::mem::align_of::<DivertAddress>(), 8);
    assert_eq!(std::mem::offset_of!(DivertAddress, data), 16);
    let mut address = DivertAddress {
        flags: 0xffff_1200,
        ..Default::default()
    };
    assert_eq!(address.event(), 0x12);
    address.set_interface(u32::MAX);
    assert_eq!(address.interface(), u32::MAX);
    address.set_outbound(false);
    assert!(!address.outbound());
    assert!(address.tcp_checksum());
    address.clear_checksums();
    assert!(!address.tcp_checksum());
}
#[test]
fn udp_reply_reuses_storage_without_stale_fields_or_tail_writes() {
    for six in [false, true] {
        let original = flow(six);
        let mut storage = vec![0xa5; 100];
        let expected = packet::udp_reply(original, &[0, 1, 255]).unwrap();
        let length = packet::write_udp_reply(&mut storage, original, &[0, 1, 255])
            .unwrap()
            .len();
        assert_eq!(&storage[..length], expected);
        assert!(storage[length..].iter().all(|b| *b == 0xa5));
        let parsed = Packet::parse(&expected, 0).unwrap();
        assert_eq!(parsed.flow.local, original.remote);
        assert_eq!(parsed.flow.remote_port, original.local_port);
        parsed
            .rewrite(
                &mut storage,
                original.local,
                original.local_port,
                original.remote,
                original.remote_port,
            )
            .unwrap();
        assert_eq!(Packet::parse(&storage, 0).unwrap().flow, original);
        for size in 0..length {
            assert!(Packet::parse(&expected[..size], 0).is_none());
        }
    }
}
#[test]
fn parser_rejects_fragments_invalid_transport_and_extensions() {
    for six in [false, true] {
        let original = packet::udp_reply(flow(six), &[1; 32]).unwrap();
        assert!(Packet::parse(&fragment(&original, 0, 16, true), 0).is_none());
        let mut bytes = original.clone();
        let header = if six { 40 } else { 20 };
        bytes[header + 4..header + 6].copy_from_slice(&7u16.to_be_bytes());
        assert!(Packet::parse(&bytes, 0).is_none());
        bytes = original.clone();
        bytes[if six { 6 } else { 9 }] = 6;
        bytes[header + 12] = 0x40;
        assert!(Packet::parse(&bytes, 0).is_none());
    }
    let mut bytes = packet::udp_reply(flow(true), &[0; 80]).unwrap();
    bytes[6] = 0;
    bytes[40] = 60;
    bytes[41] = 255;
    assert!(Packet::parse(&bytes, 0).is_none());
}
#[test]
fn wire_family_and_link_scope_remain_distinct() {
    let address = Address::read(
        &"fe80::123".parse::<std::net::Ipv6Addr>().unwrap().octets(),
        15,
    )
    .unwrap();
    let other = Address {
        scope: 16,
        ..address
    };
    assert_ne!(address, other);
    assert!(address.wire_equals(other));
    let mapped = Address {
        ip: "::ffff:127.0.0.1".parse().unwrap(),
        scope: 0,
    };
    let v4 = Address {
        ip: "127.0.0.1".parse().unwrap(),
        scope: 0,
    };
    assert!(!mapped.wire_equals(v4));
    assert!(matches!(mapped.socket(80).ip(), IpAddr::V6(_)));
}
#[test]
fn resets_obey_ack_sequence_space_and_wraparound() {
    for six in [false, true] {
        let mut bytes = packet::tcp_reset(flow(six), u32::MAX, None).unwrap();
        let header = if six { 40 } else { 20 };
        bytes[header + 13] = 2;
        let packet = Packet::parse(&bytes, 0).unwrap();
        assert!(packet.is_tcp_syn());
        let reset = packet.tcp_reset(&bytes).unwrap().unwrap();
        assert_eq!(reset[header + 13], 0x14);
        assert_eq!(&reset[header + 8..header + 12], &[0; 4]);
        bytes[header + 13] = 16;
        bytes[header + 8..header + 12].copy_from_slice(&1234u32.to_be_bytes());
        let reset = Packet::parse(&bytes, 0)
            .unwrap()
            .tcp_reset(&bytes)
            .unwrap()
            .unwrap();
        assert_eq!(reset[header + 13], 4);
        assert_eq!(Packet::parse(&reset, 0).unwrap().tcp_sequence, 1234);
        assert!(Packet::parse(&reset, 0)
            .unwrap()
            .tcp_reset(&reset)
            .unwrap()
            .is_none());
    }
}
fn checksum(bytes: impl Iterator<Item = u8>) -> u16 {
    let bytes: Vec<_> = bytes.collect();
    let mut sum = 0u32;
    for pair in bytes.chunks(2) {
        sum += u32::from(pair[0]) * 256 + u32::from(*pair.get(1).unwrap_or(&0));
    }
    while sum >> 16 != 0 {
        sum = (sum & 0xffff) + (sum >> 16);
    }
    !(sum as u16)
}
fn tcp_checksum(bytes: &[u8], header: usize) -> u16 {
    let length = bytes.len() - header;
    let pseudo = if header == 20 {
        [&bytes[12..20], &[0, 6], &(length as u16).to_be_bytes()].concat()
    } else {
        [&bytes[8..40], &(length as u32).to_be_bytes(), &[0, 0, 0, 6]].concat()
    };
    checksum(pseudo.into_iter().chain(bytes[header..].iter().copied()))
}
#[test]
fn incremental_reflection_matches_independent_full_checksums() {
    let mut seed = 17u32;
    for six in [false, true] {
        for length in [0, 1, 2, 31, 1439, 1440, 8191] {
            for _ in 0..64 {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                let mut bytes = packet::tcp_reset(flow(six), seed, Some(1)).unwrap();
                let header = if six { 40 } else { 20 };
                bytes.extend((0..length).map(|i| (seed.wrapping_add(i as u32) >> 5) as u8));
                let total = if six { bytes.len() - 40 } else { bytes.len() } as u16;
                let offset = if six { 4 } else { 2 };
                bytes[offset..offset + 2].copy_from_slice(&total.to_be_bytes());
                bytes[header + 16..header + 18].fill(0);
                let sum = tcp_checksum(&bytes, header);
                bytes[header + 16..header + 18].copy_from_slice(&sum.to_be_bytes());
                let parsed = Packet::parse(&bytes, 0).unwrap();
                let address = DivertAddress {
                    flags: 7 << 21,
                    ..Default::default()
                };
                assert!(parsed
                    .reflect(&mut bytes, seed as u16, (seed >> 16) as u16, address)
                    .unwrap());
                assert_eq!(tcp_checksum(&bytes, header), 0);
            }
        }
    }
}
#[test]
fn packed_receive_is_validated_as_a_whole_and_failed_send_is_not_retried() {
    let first = packet::udp_reply(flow(false), &[1, 2, 3]).unwrap();
    let second = packet::udp_reply(flow(true), &[4, 5]).unwrap();
    let packed = [&first[..], &second[..]].concat();
    assert_eq!(
        read_lengths(&packed, 160).unwrap(),
        vec![first.len(), second.len()]
    );
    assert!(read_lengths(&packed[..packed.len() - 1], 160).is_err());
    assert!(read_lengths(&packed, 81).is_err());
    assert!(read_lengths(&packed, 80).is_err());
    let mut batch = PacketBatch::default();
    let mut sends = 0;
    let mut fail = |_: &[u8], addresses: &[DivertAddress]| {
        sends += addresses.len();
        Err(Error::invalid("partial native send"))
    };
    for _ in 0..128 {
        batch
            .add(&first, DivertAddress::default(), &mut fail)
            .unwrap();
    }
    assert!(batch
        .add(&second, DivertAddress::default(), &mut fail)
        .is_err());
    assert_eq!(sends, 128);
    batch
        .flush(&mut |bytes: &[u8], addresses: &[DivertAddress]| {
            assert_eq!(bytes, second);
            assert_eq!(addresses.len(), 1);
            Ok(())
        })
        .unwrap();
}
#[test]
fn fragments_reassemble_out_of_order_and_never_reuse_checksum_authority() {
    for six in [false, true] {
        let original = packet::udp_reply(flow(six), &[7; 32]).unwrap();
        let mut buffer = FragmentBuffer::default();
        let address = DivertAddress {
            flags: 7 << 21,
            ..Default::default()
        };
        assert!(matches!(
            buffer
                .add(
                    &fragment(&original, 16, 24, false),
                    address,
                    0,
                    |_, _, _, _| false
                )
                .unwrap(),
            FragmentResult::Buffered
        ));
        assert!(matches!(
            buffer
                .add(
                    &fragment(&original, 16, 24, false),
                    address,
                    1,
                    |_, _, _, _| false
                )
                .unwrap(),
            FragmentResult::Buffered
        ));
        let result = buffer
            .add(
                &fragment(&original, 0, 16, true),
                address,
                2,
                |_, _, _, _| false,
            )
            .unwrap();
        let FragmentResult::Complete(batch) = result else {
            panic!("missing reassembly")
        };
        assert_eq!(batch.packet, original);
        assert_eq!(batch.originals.len(), 2);
        assert_eq!(batch.address.flags & (7 << 21), 0);
        assert_eq!(buffer.bytes(), 0);
    }
}
#[test]
fn overlapping_fragments_stay_rejected_until_expiration_and_native_bypass_flushes_originals() {
    for six in [false, true] {
        let original = packet::udp_reply(flow(six), &[0; 32]).unwrap();
        let mut buffer = FragmentBuffer::default();
        let address = DivertAddress::default();
        buffer
            .add(
                &fragment(&original, 0, 16, true),
                address,
                0,
                |_, _, _, _| false,
            )
            .unwrap();
        assert!(buffer
            .add(
                &fragment(&original, 8, 32, false),
                address,
                1,
                |_, _, _, _| false
            )
            .is_err());
        assert_eq!(buffer.bytes(), 0);
        assert!(matches!(
            buffer
                .add(
                    &fragment(&original, 16, 24, false),
                    address,
                    2,
                    |_, _, _, _| false
                )
                .unwrap(),
            FragmentResult::Buffered
        ));
        buffer.expire(15001);
        assert!(buffer.is_empty());
        buffer
            .add(
                &fragment(&original, 16, 24, false),
                address,
                15002,
                |_, _, _, _| false,
            )
            .unwrap();
        let FragmentResult::Complete(batch) = buffer
            .add(
                &fragment(&original, 0, 16, true),
                address,
                15003,
                |_, _, _, _| true,
            )
            .unwrap()
        else {
            panic!()
        };
        assert!(batch.pass_through);
        assert_eq!(batch.originals.len(), 2);
        assert_eq!(buffer.bytes(), 0);
    }
}
#[test]
fn pending_packets_count_fragments_and_preserve_retry_deadline() {
    let mut pending = PendingPackets::default();
    for i in 0..512 {
        assert!(pending.push(PendingPacket {
            bytes: vec![0; 10],
            address: DivertAddress::default(),
            arrived: i,
            fragments: vec![(vec![0; 10], DivertAddress::default())]
        }));
    }
    let packet = pending.pop().unwrap();
    assert_eq!(packet.arrived, 0);
    assert!(pending.push(packet));
    assert_eq!(pending.bytes(), 10240);
    let packet = PendingPacket {
        bytes: vec![0],
        address: DivertAddress::default(),
        arrived: 999,
        fragments: vec![],
    };
    assert!(!pending.push(packet));
    while pending.pop().is_some() {}
    assert_eq!(pending.bytes(), 0);
}
#[test]
fn arbitrary_input_does_not_panic_or_escape_size_checks() {
    let mut seed = 9284u32;
    for size in 0..1024 {
        let mut bytes = vec![0; size];
        for byte in &mut bytes {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            *byte = (seed >> 24) as u8;
        }
        Packet::parse(&bytes, u32::MAX);
        let _ = read_lengths(&bytes, 80);
        let _ =
            FragmentBuffer::default().add(&bytes, DivertAddress::default(), 0, |_, _, _, _| false);
    }
}
