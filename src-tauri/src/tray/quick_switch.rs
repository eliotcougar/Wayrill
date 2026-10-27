//! The renderer supplies workspace choices, never executable configurations.
//! A menu generation binds each click to the target visible when it was built.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Choice {
    group_id: String,
    entry_id: String,
    pub label: String,
    pub available: bool,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct View {
    pub enabled: bool,
    pub node_id: Option<String>,
    pub entries: Vec<Choice>,
}
impl View {
    pub fn validate(&self) -> Result<(), String> {
        let valid_id = |id: &str| !id.is_empty() && id.len() <= 128;
        if self.node_id.as_deref().is_some_and(|id| !valid_id(id))
            || self.entries.len() > 50_000
            || self.entries.iter().any(|entry| {
                !valid_id(&entry.group_id)
                    || !valid_id(&entry.entry_id)
                    || entry.label.chars().count() > 300
            })
        {
            return Err("Invalid quick-switch menu.".into());
        }
        Ok(())
    }
    pub fn enabled(&self) -> bool {
        self.enabled && self.node_id.is_some()
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Selection {
    node_id: String,
    choice: Option<Link>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Link {
    group_id: String,
    entry_id: String,
}

#[derive(Default)]
pub(super) struct State {
    pub generation: u64,
    pub view: View,
}
impl State {
    pub fn selection(&self, id: &str) -> Option<Selection> {
        if !self.view.enabled() {
            return None;
        }
        let key = id.strip_prefix(&format!("replace-{}-", self.generation))?;
        let choice = if key == "stash" {
            None
        } else {
            let entry = self.view.entries.get(key.parse::<usize>().ok()?)?;
            if !entry.available {
                return None;
            }
            Some(Link {
                group_id: entry.group_id.clone(),
                entry_id: entry.entry_id.clone(),
            })
        };
        Some(Selection {
            node_id: self.view.node_id.clone()?,
            choice,
        })
    }
}

pub(super) fn label(text: &str) -> String {
    // Win32 interprets ampersands as mnemonics and tabs as accelerator columns.
    text.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .replace('&', "&&")
}

#[cfg(test)]
mod tests {
    use super::*;
    fn state() -> State {
        State {
            generation: 7,
            view: View {
                enabled: true,
                node_id: Some("main".into()),
                entries: vec![Choice {
                    group_id: "group".into(),
                    entry_id: "saved".into(),
                    label: "🇳🇱 Amsterdam & Zürich · Servers".into(),
                    available: true,
                }],
            },
        }
    }
    #[test]
    fn stale_clicks_cannot_replace_a_new_main_or_a_reordered_favorite() {
        let mut menu = state();
        assert_eq!(
            serde_json::to_value(menu.selection("replace-7-0")).unwrap(),
            serde_json::json!({"nodeId":"main","choice":{"groupId":"group","entryId":"saved"}})
        );
        menu.generation += 1;
        menu.view.node_id = Some("other".into());
        assert!(menu.selection("replace-7-0").is_none());
        assert!(menu.selection("replace-8-0").is_some());
        menu.view.entries[0].available = false;
        assert!(menu.selection("replace-8-0").is_none());
        assert!(menu.selection("replace-8-stash").is_some());
        menu.view.enabled = false;
        assert!(menu.selection("replace-8-stash").is_none());
    }
    #[test]
    fn no_main_has_no_replacement_target_and_unicode_labels_remain_literal() {
        let mut menu = state();
        menu.view.node_id = None;
        assert!(menu.selection("replace-7-stash").is_none());
        assert_eq!(
            label("🇳🇱 Amsterdam & Zürich\t⚡"),
            "🇳🇱 Amsterdam && Zürich ⚡"
        );
        menu.view.entries[0].entry_id.clear();
        assert!(menu.view.validate().is_err());
    }
}
