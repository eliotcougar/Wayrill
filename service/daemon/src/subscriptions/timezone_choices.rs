//! Read only display metadata from the owner's Stash; never forward profiles.
use serde::Deserialize;
use serde_json::{json, Value};
use wayrill_protocol::{companion::TimezoneChoices, ApiError, Result};

const LIMIT: usize = 200;

#[derive(Deserialize)]
pub(super) struct Catalog {
    #[serde(skip)]
    pub version: u64,
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
    #[serde(skip)]
    search_name: String,
}
#[derive(Deserialize)]
struct Profile {
    kind: String,
}

impl Catalog {
    pub fn parse(text: Option<&str>, version: u64) -> Result<Self> {
        let mut catalog: Self =
            serde_json::from_str(text.unwrap_or(r#"{"groups":[]}"#)).map_err(|_| {
                ApiError::new(
                    "OUTBOUND_UNAVAILABLE",
                    "Cannot read the Stash outbound list.",
                )
            })?;
        catalog.version = version;
        for group in &mut catalog.groups {
            group.entries.retain_mut(|entry| {
                if entry.profile.is_none() {
                    return false;
                }
                entry.search_name = entry.name.to_lowercase();
                true
            });
        }
        Ok(catalog)
    }

    pub fn search(&self, query: &TimezoneChoices) -> Value {
        let search = query.query.trim().to_lowercase();
        let group_id = query
            .group_id
            .as_deref()
            .filter(|id| self.groups.iter().any(|g| g.id == *id));
        let mut matches = self
            .groups
            .iter()
            .filter(|g| group_id.is_none_or(|id| g.id == id))
            .flat_map(|group| {
                group
                    .entries
                    .iter()
                    .filter(|entry| entry.search_name.contains(&search))
                    .map(move |entry| (group, entry))
            });
        let items: Vec<_> = matches
            .by_ref()
            .take(LIMIT)
            .map(|(group, entry)| item(group, entry))
            .collect();
        let selected = query.selected.as_ref().and_then(|selection| {
            let group = self.groups.iter().find(|g| g.id == selection.group_id)?;
            let entry = group.entries.iter().find(|e| e.id == selection.entry_id)?;
            Some(item(group, entry))
        });
        json!({"version":self.version,"groupId":group_id,
            "groups":self.groups.iter().map(|g| json!({"id":g.id,"name":g.name})).collect::<Vec<_>>(),
            "items":items,"selected":selected,"more":matches.next().is_some()})
    }
}

fn item(group: &Group, entry: &Entry) -> Value {
    json!({"groupId":group.id,"entryId":entry.id,"name":entry.name,"kind":entry.profile.as_ref().map(|p| &p.kind)})
}

#[cfg(test)]
mod tests {
    use super::*;
    use wayrill_protocol::companion::TimezoneSelection;
    #[test]
    fn metadata_search_includes_composites_and_never_returns_credentials() {
        let stash = json!({"groups":[{"id":"g","name":"Provider","entries":[
            {"id":"server","name":"Berlin","profile":{"kind":"socks-outbound","settings":{"password":"secret"}}},
            {"id":"chain","name":"Berlin chain","profile":{"kind":"proxy-chain","settings":{"json":"secret"}}},
            {"id":"group","name":"Tokyo group","profile":{"kind":"policy-group"}},
            {"id":"draft","name":"Incomplete"}]}]}).to_string();
        let catalog = Catalog::parse(Some(&stash), 7).unwrap();
        let all = catalog.search(&TimezoneChoices::default());
        assert_eq!(all["items"].as_array().unwrap().len(), 3);
        assert!(!all.to_string().contains("secret"));
        let berlin = catalog.search(&TimezoneChoices {
            query: "BERLIN".into(),
            group_id: Some("g".into()),
            ..Default::default()
        });
        assert_eq!(berlin["items"].as_array().unwrap().len(), 2);
        assert_eq!(berlin["version"], 7);
    }

    #[test]
    fn search_reaches_the_last_of_five_thousand_entries_with_bounded_results() {
        let entries: Vec<_> = (0..5000)
            .map(|i| json!({"id":i.to_string(),"name":format!("Server {i:04}"),"profile":{"kind":"socks-outbound"}}))
            .collect();
        let stash =
            json!({"groups":[{"id":"g","name":"Large provider","entries":entries}]}).to_string();
        let catalog = Catalog::parse(Some(&stash), 8).unwrap();
        let page = catalog.search(&TimezoneChoices {
            selected: Some(TimezoneSelection {
                group_id: "g".into(),
                entry_id: "4999".into(),
                version: 7,
            }),
            ..Default::default()
        });
        assert_eq!(page["items"].as_array().unwrap().len(), 200);
        assert_eq!(page["more"], true);
        assert_eq!(page["selected"]["entryId"], "4999");
        assert_eq!(page["version"], 8);
        let filtered = catalog.search(&TimezoneChoices {
            query: "SERVER 4999".into(),
            group_id: Some("removed group".into()),
            ..Default::default()
        });
        assert!(filtered["groupId"].is_null());
        assert_eq!(filtered["items"].as_array().unwrap().len(), 1);
        assert_eq!(filtered["items"][0]["entryId"], "4999");
        assert_eq!(filtered["more"], false);
    }
}
