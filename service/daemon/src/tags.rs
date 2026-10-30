use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};

pub fn encode(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn number(mut value: u64) -> String {
    const DIGITS: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut bytes = Vec::new();
    loop {
        bytes.push(DIGITS[(value & 63) as usize]);
        value >>= 6;
        if value == 0 {
            break;
        }
    }
    bytes.reverse();
    String::from_utf8(bytes).unwrap()
}

pub fn sequence(values: &[u64]) -> String {
    let mut bytes = Vec::new();
    for &value in values {
        let mut value = value;
        loop {
            let byte = (value & 127) as u8;
            value >>= 7;
            bytes.push(if value == 0 { byte } else { byte | 128 });
            if value == 0 {
                break;
            }
        }
    }
    encode(&bytes)
}

#[cfg(test)]
mod tests {
    #[test]
    fn identifiers_use_unpadded_base64url_without_losing_bits() {
        assert_eq!(super::encode(&[255; 16]), "_____________________w");
        assert_eq!(super::number(u64::MAX), "P__________");
        assert_eq!(super::sequence(&[1, 7, 0]), "AQcA");
        // A delimiter from the Base64url alphabet cannot separate variable IDs.
        assert_ne!(
            super::sequence(&[1, 126, 0]),
            super::sequence(&[1, 1, 3968])
        );
    }
}
