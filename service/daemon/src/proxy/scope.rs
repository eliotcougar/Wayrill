//! Write-ahead scope changes keep the managed lease until the new store is
//! verified. An interrupted change rolls back to the old scope and binding.
use super::{
    check_scope, policy_scope, read_policy, recovery_after_switch, recovery_decision,
    replace_policy, run_helper, run_helper_checked, Lease, ProxySettings, Recovery, Scope,
    ScopeChange,
};
use crate::{lifecycle::Cleanup, storage};
use serde::{Deserialize, Serialize};
use std::path::Path;
use wayrill_protocol::{ApiError, Result};

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum Phase {
    ReleasingBinding,
    SwitchingPolicy,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Transition {
    previous_policy: Option<u32>,
    requested: Scope,
    phase: Phase,
    was_applied: bool,
}

pub(super) trait Native {
    fn policy(&self) -> Result<Option<u32>>;
    fn set_policy(&self, expected: Option<u32>, next: Option<u32>) -> Result<()>;
    fn refresh(&self) -> Result<ProxySettings>;
    fn read(&self) -> Result<ProxySettings>;
    fn write(&self, expected: &ProxySettings, settings: &ProxySettings) -> Result<ProxySettings>;
}

pub(super) struct Windows<'a> {
    pub(super) exe: &'a Path,
    pub(super) owner: &'a str,
}

impl Native for Windows<'_> {
    fn policy(&self) -> Result<Option<u32>> {
        read_policy()
    }
    fn set_policy(&self, expected: Option<u32>, next: Option<u32>) -> Result<()> {
        replace_policy(expected, next)
    }
    fn refresh(&self) -> Result<ProxySettings> {
        run_helper(self.exe, self.owner, "refresh", None)
    }
    fn read(&self) -> Result<ProxySettings> {
        run_helper(self.exe, self.owner, "get", None)
    }
    fn write(&self, expected: &ProxySettings, settings: &ProxySettings) -> Result<ProxySettings> {
        run_helper_checked(
            self.exe,
            self.owner,
            "set",
            Some(settings),
            Some(&crate::system_settings::version(expected)),
        )
    }
}

fn conflict() -> ApiError {
    ApiError::new(
        "PROXY_CONFLICT",
        "Windows proxy scope or settings changed externally. Those changes were preserved.",
    )
}

fn restore_binding(native: &impl Native, lease: &Lease) -> Result<bool> {
    match recovery_decision(&native.read()?, &lease.before, &lease.applied) {
        Recovery::AlreadyRestored => Ok(false),
        Recovery::Restore => write_verified(native, &lease.applied, &lease.before).map(|()| true),
        Recovery::Conflict => Err(conflict()),
    }
}

fn write_verified(
    native: &impl Native,
    expected: &ProxySettings,
    settings: &ProxySettings,
) -> Result<()> {
    if native.write(expected, settings)? != *settings {
        return Err(ApiError::new(
            "PROXY_ERROR",
            "Windows did not retain the restored proxy settings.",
        ));
    }
    Ok(())
}

fn rollback_policy(native: &impl Native, transition: Transition) -> Result<Scope> {
    let current = native.policy()?;
    let requested = Some(transition.requested.policy_value());
    if current != transition.previous_policy {
        if transition.phase != Phase::SwitchingPolicy || current != requested {
            return Err(conflict());
        }
        native.set_policy(requested, transition.previous_policy)?;
    }
    let previous = policy_scope(transition.previous_policy)?;
    check_scope(native.refresh()?.scope, previous)?;
    Ok(previous)
}

pub(super) fn recover(journal: &Path, native: &impl Native, resume_binding: bool) -> Result<bool> {
    let Some(mut lease) = storage::read::<Lease>(journal)? else {
        return Ok(false);
    };
    let Some(transition) = lease.scope_switch else {
        return Ok(false);
    };
    let result = (|| {
        let active = rollback_policy(native, transition)?;
        if resume_binding && transition.was_applied && lease.applied.scope == active {
            let current = native.read()?;
            // Resume only when the old baseline or the original binding is
            // still present. An external write must win over our rollback.
            if current != lease.applied {
                if current != lease.before {
                    return Err(conflict());
                }
                write_verified(native, &lease.before, &lease.applied)?;
            }
        }
        Ok(())
    })();
    // On a conflict retain ordinary ownership evidence so the user can still
    // restore or acknowledge it, but stop trying to reverse an external edit.
    if result.is_ok()
        || result
            .as_ref()
            .is_err_and(|error| error.code == "PROXY_CONFLICT")
    {
        lease.scope_switch = None;
        storage::write(journal, &lease)?;
    }
    result.map(|()| true)
}

pub(super) fn change(journal: &Path, native: &impl Native, request: ScopeChange) -> Result<bool> {
    let current = native.read()?;
    if crate::system_settings::version(&current) != request.expected_version {
        return Err(ApiError::new(
            "SETTINGS_CONFLICT",
            "Windows proxy changed; refresh before switching scope.",
        ));
    }
    if current.scope == request.scope {
        return Ok(false);
    }
    let previous_policy = native.policy()?;
    check_scope(policy_scope(previous_policy)?, current.scope)?;
    let mut lease = storage::read::<Lease>(journal)?;
    let recover_target = recovery_after_switch(&current, lease.as_ref(), request.scope)?;
    let mut transition = Transition {
        previous_policy,
        requested: request.scope,
        phase: Phase::ReleasingBinding,
        was_applied: lease.as_ref().is_some_and(|lease| current == lease.applied),
    };

    let next_policy = Some(request.scope.policy_value());
    let result = (|| {
        if let Some(lease) = &mut lease {
            lease.scope_switch = Some(transition);
            storage::write(journal, lease)?;
            if !recover_target {
                transition.was_applied = restore_binding(native, lease)?;
            }
            lease.scope_switch = Some(Transition {
                phase: Phase::SwitchingPolicy,
                ..transition
            });
            storage::write(journal, lease)?;
        }
        if let Err(error) = native.set_policy(previous_policy, next_policy) {
            // A rejected write is known not to have changed the policy. Keep
            // that fact durable so recovery cannot undo a competing change.
            if let Some(lease) = &mut lease {
                lease.scope_switch = Some(transition);
                return Err(Cleanup::after_failure(
                    error,
                    "record rejected proxy scope write",
                    storage::write(journal, lease),
                ));
            }
            return Err(error);
        }
        transition.phase = Phase::SwitchingPolicy;
        check_scope(native.refresh()?.scope, request.scope)?;
        if native.policy()? != next_policy {
            return Err(conflict());
        }
        if recover_target {
            restore_binding(native, lease.as_ref().unwrap())?;
        }
        if lease.is_some() {
            storage::remove(journal)?;
        }
        Ok(true)
    })();
    // An unmanaged scope change has no assignment journal to recover.
    if lease.is_none() && transition.phase == Phase::SwitchingPolicy {
        return result.map_err(|error| {
            Cleanup::after_failure(
                error,
                "restore Windows proxy scope",
                rollback_policy(native, transition).map(|_| ()),
            )
        });
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        cell::{Cell, RefCell},
        path::PathBuf,
    };

    struct Stores {
        policy: Cell<Option<u32>>,
        user: RefCell<ProxySettings>,
        machine: RefCell<ProxySettings>,
        reject_policy: Cell<bool>,
        fail_refresh: Cell<bool>,
    }

    impl Native for Stores {
        fn policy(&self) -> Result<Option<u32>> {
            Ok(self.policy.get())
        }
        fn set_policy(&self, expected: Option<u32>, next: Option<u32>) -> Result<()> {
            assert_eq!(self.policy.get(), expected);
            if self.reject_policy.replace(false) {
                return Err(ApiError::new("PROXY_POLICY", "Policy write failed"));
            }
            self.policy.set(next);
            Ok(())
        }
        fn refresh(&self) -> Result<ProxySettings> {
            if self.fail_refresh.replace(false) {
                return Err(ApiError::new("PROXY_ERROR", "Helper refresh failed"));
            }
            self.read()
        }
        fn read(&self) -> Result<ProxySettings> {
            Ok(if self.policy.get() == Some(0) {
                self.machine.borrow()
            } else {
                self.user.borrow()
            }
            .clone())
        }
        fn write(&self, expected: &ProxySettings, value: &ProxySettings) -> Result<ProxySettings> {
            assert_eq!(self.read()?, *expected);
            assert_eq!(value.scope, policy_scope(self.policy.get())?);
            let store = if value.scope == Scope::Machine {
                &self.machine
            } else {
                &self.user
            };
            *store.borrow_mut() = value.clone();
            Ok(value.clone())
        }
    }

    fn settings(scope: Scope, server: &str) -> ProxySettings {
        ProxySettings {
            scope,
            flags: 3,
            server: server.into(),
            bypass: String::new(),
            auto_config_url: String::new(),
        }
    }

    fn fixture() -> (PathBuf, Stores, ScopeChange, Lease) {
        let journal = std::env::temp_dir().join(format!(
            "wayrill-proxy-scope-{}.json",
            crate::tun::random_id().unwrap()
        ));
        let lease = Lease {
            before: settings(Scope::User, "original"),
            applied: settings(Scope::User, "wayrill"),
            binding: None,
            scope_switch: None,
        };
        storage::write(&journal, &lease).unwrap();
        let stores = Stores {
            // A missing policy must roll back to a missing value, not to DWORD 1.
            policy: Cell::new(None),
            user: RefCell::new(lease.applied.clone()),
            machine: RefCell::new(settings(Scope::Machine, "machine")),
            reject_policy: Cell::new(false),
            fail_refresh: Cell::new(false),
        };
        let request = ScopeChange {
            scope: Scope::Machine,
            expected_version: crate::system_settings::version(&lease.applied),
        };
        (journal, stores, request, lease)
    }

    #[test]
    fn failed_switch_recovers_previous_binding_from_the_durable_lease() {
        for fail_before_policy_write in [true, false] {
            let (journal, native, request, lease) = fixture();
            native.reject_policy.set(fail_before_policy_write);
            native.fail_refresh.set(!fail_before_policy_write);
            assert!(change(&journal, &native, request).is_err());
            let saved = storage::read::<Lease>(&journal).unwrap().unwrap();
            assert_eq!(saved.applied, lease.applied);
            assert!(saved.scope_switch.is_some());
            assert_eq!(*native.user.borrow(), lease.before);

            assert!(recover(&journal, &native, true).unwrap());
            assert_eq!(native.policy.get(), None);
            assert_eq!(*native.user.borrow(), lease.applied);
            assert_eq!(native.machine.borrow().server, "machine");
            assert!(!recover(&journal, &native, true).unwrap());
            storage::remove(&journal).unwrap();
        }
    }

    #[test]
    fn rollback_keeps_a_binding_inactive_if_it_was_already_restored() {
        let (journal, native, mut request, lease) = fixture();
        *native.user.borrow_mut() = lease.before.clone();
        request.expected_version = crate::system_settings::version(&lease.before);
        native.fail_refresh.set(true);
        assert!(change(&journal, &native, request).is_err());
        assert!(recover(&journal, &native, true).unwrap());
        assert_eq!(*native.user.borrow(), lease.before);
        storage::remove(&journal).unwrap();
    }

    #[test]
    fn scope_recovery_preserves_an_external_proxy_edit() {
        let (journal, native, request, _) = fixture();
        native.fail_refresh.set(true);
        assert!(change(&journal, &native, request).is_err());
        native.user.borrow_mut().server = "external".into();
        let error = recover(&journal, &native, true).unwrap_err();
        assert_eq!(error.code, "PROXY_CONFLICT");
        assert_eq!(native.user.borrow().server, "external");
        let saved = storage::read::<Lease>(&journal).unwrap().unwrap();
        assert!(saved.scope_switch.is_none());
        storage::remove(&journal).unwrap();
    }

    #[test]
    fn verified_scope_switch_releases_the_previous_store_without_copying_the_binding() {
        let (journal, native, request, lease) = fixture();
        assert!(change(&journal, &native, request).unwrap());
        assert_eq!(native.policy.get(), Some(0));
        assert_eq!(*native.user.borrow(), lease.before);
        assert_eq!(native.machine.borrow().server, "machine");
        assert!(!journal.exists());
    }
}
