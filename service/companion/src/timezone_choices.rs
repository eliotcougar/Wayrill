//! Read only display metadata from the owner's Stash; never forward profiles.
use serde::Deserialize;
use serde_json::{json, Value};
use wayrill_protocol::{ApiError, Result};

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Query {
    #[serde(default)]
    pub query: String,
    pub group_id: Option<String>,
}
impl Query {
    pub fn validate(&self) -> Result<()> {
        if self.query.len() > 256 || self.group_id.as_ref().is_some_and(|id| id.len() > 160) {
            return Err(ApiError::new("INVALID_REQUEST", "Invalid Stash search."));
        }
        Ok(())
    }
}
#[derive(Deserialize)]
struct Library {
    groups: Vec<Group>,
}
#[derive(Deserialize)]
struct Group {
    id: String,
    name: String,
    entries: Vec<Entry>,
}
#[derive(Deserialize)]
struct Entry {
    id: String,
    name: String,
    profile: Option<Profile>,
}
#[derive(Deserialize)]
struct Profile {
    kind: String,
}

fn choices(text: &str, version: u64, query: &Query) -> Result<Value> {
    let stash: Library = serde_json::from_str(text).map_err(|_| {
        ApiError::new(
            "OUTBOUND_UNAVAILABLE",
            "Cannot read the Stash outbound list.",
        )
    })?;
    let search = query.query.to_lowercase();
    let mut items = Vec::new();
    let mut more = false;
    for group in &stash.groups {
        if query.group_id.as_ref().is_some_and(|id| id != &group.id) {
            continue;
        }
        for entry in &group.entries {
            let Some(profile) = &entry.profile else {
                continue;
            };
            if !entry.name.to_lowercase().contains(&search) {
                continue;
            }
            if items.len() == 200 {
                more = true;
                break;
            }
            items.push(json!({"groupId":group.id,"entryId":entry.id,"name":entry.name,"kind":profile.kind}));
        }
    }
    Ok(
        json!({"version":version,"groups":stash.groups.iter().map(|g| json!({"id":g.id,"name":g.name})).collect::<Vec<_>>(),"items":items,"more":more}),
    )
}

pub(crate) async fn read(query: Query) -> Result<Value> {
    query.validate()?;
    let mut text = String::new();
    let mut version = None;
    loop {
        let page = wayrill_ipc::windows::request(
            "subscriptions.read",
            json!({"kind":"stash","offset":text.len(),"version":version}),
        )
        .await?;
        version = page["version"].as_u64();
        let chunk = page["text"]
            .as_str()
            .ok_or_else(|| ApiError::new("OUTBOUND_UNAVAILABLE", "Cannot read Stash."))?;
        if text.len() + chunk.len() > 64 * 1024 * 1024 {
            return Err(ApiError::new(
                "OUTBOUND_UNAVAILABLE",
                "Stash exceeds its size limit.",
            ));
        }
        text.push_str(chunk);
        if page["totalBytes"].as_u64() == Some(text.len() as u64) {
            break;
        }
        if chunk.is_empty() {
            return Err(ApiError::new("OUTBOUND_UNAVAILABLE", "Incomplete Stash."));
        }
    }
    if text.is_empty() {
        return Ok(json!({"version":version,"groups":[],"items":[],"more":false}));
    }
    choices(&text, version.unwrap_or(0), &query)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_search_includes_composites_and_never_returns_credentials() {
        let stash = json!({"groups":[{"id":"g","name":"Provider","entries":[
            {"id":"server","name":"Berlin","profile":{"kind":"socks-outbound","settings":{"password":"secret"}}},
            {"id":"chain","name":"Berlin chain","profile":{"kind":"proxy-chain","settings":{"json":"secret"}}},
            {"id":"group","name":"Tokyo group","profile":{"kind":"policy-group"}},
            {"id":"draft","name":"Incomplete"}]}]}).to_string();
        let all = choices(&stash, 7, &Query::default()).unwrap();
        assert_eq!(all["items"].as_array().unwrap().len(), 3);
        assert!(!all.to_string().contains("secret"));
        let berlin = choices(
            &stash,
            7,
            &Query {
                query: "BERLIN".into(),
                group_id: Some("g".into()),
            },
        )
        .unwrap();
        assert_eq!(berlin["items"].as_array().unwrap().len(), 2);
        assert_eq!(berlin["version"], 7);
    }
}
