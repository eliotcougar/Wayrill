//! One-shot installer handoff. No public elevated command or permanent preference.
use crate::{storage, system_settings};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::Path;
use wayrill_protocol::{ApiError, Result};

pub fn path(profile: &Path) -> std::path::PathBuf {
    profile.with_file_name("upgrade-resume.json")
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub transaction_id: String,
    pub service_version: String,
    pub ok: bool,
    pub error: Option<ApiError>,
    pub core: crate::lifecycle::CoreState,
    pub revision: u64,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "phase", rename_all = "camelCase")]
pub enum Progress {
    Retrying { intent: Value, result: Receipt },
    Completed { result: Receipt },
}

#[derive(Deserialize)]
#[serde(untagged)]
pub enum Handoff {
    Progress(Progress),
    // The retiring installer must still be able to stage the original v1 intent.
    Prepared(Value),
}

pub fn load(profile: &Path) -> Result<Option<Handoff>> {
    storage::read(&path(profile))
}

pub fn pending(profile: &Path) -> bool {
    !matches!(
        load(profile),
        Ok(None | Some(Handoff::Progress(Progress::Completed { .. })))
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Intent {
    version: u32,
    transaction_id: String,
    owner_sid: String,
    revision: u64,
    profile_sha256: Option<String>,
    pub resume_routing: bool,
    pub settings: Vec<system_settings::Request>,
}
/// A prior resume attempt may already have restored some scopes. Only matching
/// owned assignments are resumable; external edits still fail check_owned/CAS.
pub fn remaining(
    settings: Vec<system_settings::Request>,
    owned: &[system_settings::Request],
) -> Result<Vec<system_settings::Request>> {
    let mut remaining = Vec::new();
    for request in settings {
        if let Some(current) = owned.iter().find(|r| r.channel == request.channel) {
            let mut a = serde_json::to_value(&request).unwrap();
            let mut b = serde_json::to_value(current).unwrap();
            a.as_object_mut().unwrap().remove("expectedVersion");
            b.as_object_mut().unwrap().remove("expectedVersion");
            if a != b {
                return Err(ApiError::new("SETTINGS_CONFLICT", "An owned proxy assignment differs from the pending upgrade. Stop before applying another configuration."));
            }
        } else {
            remaining.push(request);
        }
    }
    Ok(remaining)
}
pub fn validate(value: Value, owner: &str, revision: u64, profile: &Path) -> Result<Intent> {
    let intent: Intent = serde_json::from_value(value)
        .map_err(|_| ApiError::new("UPGRADE_STATE", "Invalid protected upgrade handoff."))?;
    if intent.version != 1
        || intent.owner_sid != owner
        || intent.revision != revision
        || intent.transaction_id.len() != 32
        || !intent.transaction_id.bytes().all(|b| b.is_ascii_hexdigit())
        || intent.settings.len() > 6
    {
        return Err(ApiError::new(
            "UPGRADE_STATE",
            "The upgrade handoff does not match this installation and applied revision.",
        ));
    }
    let hash = match std::fs::read(profile) {
        Ok(bytes) => Some(crate::system_native::hex(&Sha256::digest(bytes))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(ApiError::io("Check upgrade's applied profile", error)),
    };
    if hash != intent.profile_sha256 || (intent.resume_routing && hash.is_none()) {
        return Err(ApiError::new(
            "UPGRADE_STATE",
            "The applied profile changed during installation; it was not started automatically.",
        ));
    }
    let mut channels = std::collections::BTreeSet::new();
    for request in &intent.settings {
        system_settings::validate(request)?;
        if request.expected_version.len() != 64
            || !request
                .expected_version
                .bytes()
                .all(|b| b.is_ascii_hexdigit())
            || !channels.insert(request.channel)
        {
            return Err(ApiError::new(
                "UPGRADE_STATE",
                "Invalid or duplicate upgrade proxy assignment.",
            ));
        }
    }
    Ok(intent)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn upgrade_result_replaces_pending_intent_without_a_missing_record() {
        let dir =
            std::env::temp_dir().join(format!("wayrill-upgrade-journal-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let profile = dir.join("profile.json");
        let intent = json!({"version":1,"transactionId":"a".repeat(32),"ownerSid":"owner","revision":4,"resumeRouting":false,"settings":[]});
        storage::write(&path(&profile), &intent).unwrap();
        assert!(pending(&profile));

        let receipt = |error: Option<ApiError>| Receipt {
            transaction_id: "a".repeat(32),
            service_version: "test".into(),
            ok: error.is_none(),
            error,
            core: crate::lifecycle::CoreState::Stopped,
            revision: 4,
        };
        storage::write(
            &path(&profile),
            &Progress::Retrying {
                intent: intent.clone(),
                result: receipt(Some(ApiError::new(
                    "SETTINGS_CONFLICT",
                    "Changed externally",
                ))),
            },
        )
        .unwrap();
        assert!(pending(&profile));
        let Handoff::Progress(Progress::Retrying {
            intent: saved,
            result,
        }) = load(&profile).unwrap().unwrap()
        else {
            panic!("interrupted handoff lost its retry state");
        };
        assert_eq!(saved, intent);
        assert_eq!(result.error.unwrap().code, "SETTINGS_CONFLICT");

        storage::write(
            &path(&profile),
            &Progress::Completed {
                result: receipt(None),
            },
        )
        .unwrap();
        assert!(!pending(&profile));
        let state: Value = storage::read(&path(&profile)).unwrap().unwrap();
        assert_eq!(state["phase"], "completed");
        assert_eq!(state["result"]["transactionId"], intent["transactionId"]);
        assert_eq!(state["result"]["ok"], true);
        storage::remove(&path(&profile)).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }
    #[test]
    fn resume_skips_only_identical_owned_bindings_and_preserves_unowned_cas() {
        let original: system_settings::Request = serde_json::from_value(
            json!({"channel":"wininet","expectedVersion":"old","inputTag":"proxy"}),
        )
        .unwrap();
        let second: system_settings::Request = serde_json::from_value(json!({"channel":"envUser","expectedVersion":"unchanged","inputTag":"proxy","http":true})).unwrap();
        let mut restored = original.clone();
        restored.expected_version = "restored".into();
        let pending = remaining(vec![original.clone(), second], &[restored.clone()]).unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].expected_version, "unchanged");
        restored.input_tag = "another-proxy".into();
        assert_eq!(
            remaining(vec![original], &[restored]).unwrap_err().code,
            "SETTINGS_CONFLICT"
        );
    }
    #[test]
    fn upgrade_accepts_all_six_scopes_but_rejects_duplicate_assignments() {
        let path =
            std::env::temp_dir().join(format!("wayrill-absent-scopes-{}", std::process::id()));
        let settings: Vec<Value> = [
            "wininet",
            "envUser",
            "envMachine",
            "winhttpLegacy",
            "winhttpMachine",
            "winhttpUser",
        ]
        .into_iter()
        .map(|channel| json!({"channel":channel,"expectedVersion":"a".repeat(64),"http":true}))
        .collect();
        let mut value = json!({"version":1,"transactionId":"a".repeat(32),"ownerSid":"owner","revision":4,"profileSha256":null,"resumeRouting":false,"settings":settings});
        assert!(validate(value.clone(), "owner", 4, &path).is_ok());
        value["settings"][5]["channel"] = json!("winhttpMachine");
        assert_eq!(
            validate(value.clone(), "owner", 4, &path)
                .err()
                .unwrap()
                .code,
            "UPGRADE_STATE"
        );
        let extra = value["settings"][0].clone();
        value["settings"].as_array_mut().unwrap().push(extra);
        assert_eq!(
            validate(value, "owner", 4, &path).err().unwrap().code,
            "UPGRADE_STATE"
        );
    }
    #[test]
    fn stopped_empty_install_can_resume_only_the_exact_owner_and_revision() {
        let path =
            std::env::temp_dir().join(format!("wayrill-absent-upgrade-{}", std::process::id()));
        let value = json!({"version":1,"transactionId":"a".repeat(32),"ownerSid":"owner","revision":4,"profileSha256":null,"resumeRouting":false,"settings":[]});
        assert!(validate(value.clone(), "owner", 4, &path).is_ok());
        assert!(validate(value.clone(), "other", 4, &path).is_err());
        assert!(validate(value.clone(), "owner", 5, &path).is_err());
        let mut running = value.clone();
        running["resumeRouting"] = json!(true);
        assert!(validate(running, "owner", 4, &path).is_err());
        let mut unknown = value;
        unknown["command"] = json!("arbitrary");
        assert!(validate(unknown, "owner", 4, &path).is_err());
    }
    #[test]
    fn running_upgrade_requires_the_unchanged_applied_profile_file() {
        let path = std::env::temp_dir().join(format!(
            "wayrill-upgrade-profile-{}.json",
            std::process::id()
        ));
        let bytes = br#"{"hash":"example","revision":9}"#;
        std::fs::write(&path, bytes).unwrap();
        let value = json!({"version":1,"transactionId":"b".repeat(32),"ownerSid":"owner","revision":9,"profileSha256":crate::system_native::hex(&Sha256::digest(bytes)),"resumeRouting":true,"settings":[]});
        assert!(validate(value.clone(), "owner", 9, &path).is_ok());
        std::fs::write(&path, b"different applied profile").unwrap();
        assert_eq!(
            validate(value.clone(), "owner", 9, &path)
                .err()
                .unwrap()
                .code,
            "UPGRADE_STATE"
        );
        std::fs::remove_file(&path).unwrap();
        assert!(validate(value, "owner", 9, &path).is_err());
    }
}
