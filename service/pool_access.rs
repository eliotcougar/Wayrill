//! Read and authenticate a published Pool invitation under the caller's identity.
use aes_gcm::{
    aead::{Aead, Payload},
    Aes256Gcm, KeyInit, Nonce,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::File,
    io::Read,
    path::{Component, Path, Prefix},
};
use wayrill_protocol::{ApiError, Result, MAX_CONFIG as MAX_FILE};

fn error(message: &str) -> ApiError {
    ApiError::new("POOL", message)
}

pub fn publication(text: &str) -> Result<(Value, u64, String)> {
    let mut bundle: Value =
        serde_json::from_str(text).map_err(|_| error("Invalid Wayrill Pool configuration."))?;
    let version = match bundle
        .as_object_mut()
        .and_then(|obj| obj.remove("publication"))
    {
        None => 0,
        Some(value) => value
            .as_u64()
            .filter(|version| (1..=9_007_199_254_740_991).contains(version))
            .ok_or_else(|| error("Invalid Pool publication number."))?,
    };
    let digest = if version == 0 {
        Sha256::digest(text.as_bytes())
    } else {
        Sha256::digest(bundle.to_string().as_bytes())
    };
    Ok((bundle, version, STANDARD.encode(digest)))
}

fn hex(text: &str, bytes: usize) -> bool {
    text.len() == bytes * 2
        && text
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Source {
    pub kind: String,
    pub address: String,
    invite: String,
}
impl Source {
    pub fn parts(&self) -> Result<(&str, &str)> {
        self.invite
            .strip_prefix("wp1.")
            .and_then(|value| value.split_once('.'))
            .filter(|(recipient, key)| hex(recipient, 16) && hex(key, 32))
            .ok_or_else(|| {
                error("Enter the private access key supplied by the Pool administrator.")
            })
    }
    pub fn location(&self) -> Result<String> {
        let (recipient, _) = self.parts()?;
        let name = format!("{recipient}.wayrill-pool.json");
        match self.kind.as_str() {
            "folder" => {
                let root = Path::new(&self.address);
                if self.address.len() > 2048
                    || self.address.contains('\0')
                    || !root.is_absolute()
                    || !matches!(root.components().next(), Some(Component::Prefix(p)) if matches!(p.kind(), Prefix::Disk(_) | Prefix::UNC(..)))
                    || self.address.get(2..).is_some_and(|rest| rest.contains(':'))
                {
                    return Err(error("Choose an absolute path to the Pool folder."));
                }
                Ok(root.join(name).to_string_lossy().into_owned())
            }
            "url" => {
                let mut url = url::Url::parse(&self.address)
                    .map_err(|_| error("Enter the Pool folder URL."))?;
                let loopback = match url.host() {
                    Some(url::Host::Ipv4(address)) => address.is_loopback(),
                    Some(url::Host::Ipv6(address)) => address.is_loopback(),
                    Some(url::Host::Domain("localhost")) => true,
                    _ => false,
                };
                if self.address.len() > 2048
                    || url.host().is_none()
                    || !url.username().is_empty()
                    || url.password().is_some()
                    || url.query().is_some()
                    || url.fragment().is_some()
                    || !(url.scheme() == "https" || url.scheme() == "http" && loopback)
                {
                    return Err(error("Use an HTTPS folder URL, or HTTP on localhost, without credentials or a query."));
                }
                url.path_segments_mut()
                    .map_err(|_| error("Invalid Pool folder URL."))?
                    .pop_if_empty()
                    .push(&name);
                Ok(url.into())
            }
            _ => Err(error("Choose Folder or URL.")),
        }
    }
}

fn folder_file(path: &str) -> Result<String> {
    let file = File::open(path)
        .map_err(|_| error("Cannot open the Pool access file. It may have been withdrawn."))?;
    if !file
        .metadata()
        .map_err(|_| error("Cannot inspect the Pool access file."))?
        .is_file()
    {
        return Err(error("Pool access must be a regular file."));
    }
    let mut text = String::new();
    file.take(MAX_FILE as u64 + 1)
        .read_to_string(&mut text)
        .map_err(|_| error("Cannot read the Pool access file."))?;
    if text.len() > MAX_FILE {
        return Err(error("The Pool access file exceeds 16 MiB."));
    }
    Ok(text)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    format: String,
    version: u32,
    recipient: String,
    nonce: String,
    data: String,
}
fn decode(text: &str, recipient: &str, key: &str) -> Result<String> {
    if text.len() > MAX_FILE {
        return Err(error("The Pool access file exceeds 16 MiB."));
    }
    let invalid = || error("The Pool access key is incorrect, or the access file is invalid.");
    let envelope: Envelope = serde_json::from_str(text).map_err(|_| invalid())?;
    if envelope.format != "wayrill.pool.access"
        || envelope.version != 1
        || envelope.recipient != recipient
    {
        return Err(invalid());
    }
    let key: Vec<u8> = (0..key.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&key[at..at + 2], 16))
        .collect::<std::result::Result<_, _>>()
        .map_err(|_| invalid())?;
    let nonce = STANDARD.decode(envelope.nonce).map_err(|_| invalid())?;
    let nonce: [u8; 12] = nonce.try_into().map_err(|_| invalid())?;
    let data = STANDARD.decode(envelope.data).map_err(|_| invalid())?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| invalid())?;
    let aad = format!("wayrill.pool.access:1:{recipient}");
    let plaintext = cipher
        .decrypt(
            &Nonce::from(nonce),
            Payload {
                msg: &data,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| invalid())?;
    String::from_utf8(plaintext).map_err(|_| invalid())
}

pub fn download(source: &Source) -> Result<String> {
    let location = source.location()?;
    let text = if source.kind == "folder" {
        folder_file(&location)?
    } else {
        crate::subscription_http::fetch_with_policy(
            &location,
            location.starts_with("http://"),
            "",
            &BTreeMap::from([("Cache-Control".into(), "no-cache".into())]),
            None,
            true,
        )
        .map_err(|message| error(&format!("Pool download failed. {message}")))?
    };
    let (recipient, key) = source.parts()?;
    decode(&text, recipient, key)
}
