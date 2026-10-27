// SPDX-License-Identifier: GPL-3.0-only
//! Fixed inherited-pipe command controller. User/session authorization and the
//! settings journal belong to the service; this worker exposes no generic API.
use crate::{
    capture::CaptureEngine,
    native::{self, divert::Api},
    policy::Plan,
    text,
    tun_applications::{TunApplications, TunInput},
    wire::Command,
    Error, Result,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

#[derive(Default)]
pub struct Controller {
    engine: Option<CaptureEngine>,
    applications: Option<TunApplications>,
    active: Option<Plan>,
    started: u64,
    failure: Option<String>,
    api: Option<Arc<Api>>,
}
impl Controller {
    fn api(&mut self) -> Result<Arc<Api>> {
        if self.api.is_none() {
            self.api = Some(Api::load()?);
        }
        Ok(self.api.as_ref().unwrap().clone())
    }
    pub async fn command(
        &mut self,
        request: Command<'_>,
        progress: &mut crate::sharing::Report<'_>,
    ) -> Result<Value> {
        let result = self.execute(request.method, request.data, progress).await;
        match result {
            Err(error)
                if request.method == "start"
                    || self
                        .engine
                        .as_ref()
                        .is_some_and(|e| e.failure().ok().flatten().is_some()) =>
            {
                match self.stop().await {
                    Ok(()) => Err(error),
                    Err(cleanup) => Err(Error::invalid(format!("{error} Cleanup: {cleanup}"))),
                }
            }
            result => result,
        }
    }
    async fn execute(
        &mut self,
        method: &str,
        data: &Value,
        progress: &mut crate::sharing::Report<'_>,
    ) -> Result<Value> {
        match method {
            "sharing.inspect" => Ok(serde_json::to_value(native::sharing::inspect(progress)?)?),
            "sharing.set" => Ok(serde_json::to_value(native::sharing::change(
                serde_json::from_value(data.clone())?,
                progress,
            )?)?),
            "applications.start" => {
                if self.applications.is_some() || self.engine.is_some() {
                    return Err(Error::invalid("Worker already in use."));
                }
                let input: TunInput = serde_json::from_value(data.clone())?;
                let applications = TunApplications::start(input).await?;
                let result = serde_json::to_value(applications.endpoint())?;
                self.applications = Some(applications);
                Ok(result)
            }
            "applications.status" => {
                if let Some(app) = &self.applications {
                    app.check_health()?;
                }
                Ok(json!({"state":if self.applications.is_some(){"running"}else{"stopped"}}))
            }
            "catalog" => catalog(owner_sid(data)?),
            "loopback.get" => {
                let packages = native::packages::read(Some(owner_sid(data)?))?;
                Ok(serde_json::to_value(native::loopback::snapshot(
                    &packages,
                )?)?)
            }
            "loopback.set" => {
                let packages = native::packages::read(Some(owner_sid(data)?))?;
                let version = data
                    .get("expectedVersion")
                    .and_then(Value::as_str)
                    .ok_or_else(|| Error::invalid("Missing loopback version."))?;
                let changes: Vec<native::loopback::Change> = serde_json::from_value(
                    data.get("changes")
                        .ok_or_else(|| Error::invalid("Missing loopback changes."))?
                        .clone(),
                )?;
                Ok(serde_json::to_value(native::loopback::apply(
                    &packages, version, &changes,
                )?)?)
            }
            "firewall.clear" => {
                if self.engine.is_some() {
                    return Err(Error::invalid(
                        "Cannot recover firewall rules while capture is active.",
                    ));
                }
                native::firewall::clear_stale()?;
                Ok(json!({"cleared":true}))
            }
            "check" => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct Check {
                    owned_capture_pid: Option<u32>,
                    service_pid: Option<u32>,
                }
                let check: Check = serde_json::from_value(data.clone())?;
                native::capture_availability::check(
                    &self.api()?,
                    check.owned_capture_pid,
                    check.service_pid,
                )?;
                Ok(json!({"available":true}))
            }
            "start" => {
                if self.engine.is_some() || self.applications.is_some() {
                    return Err(Error::invalid("Capture is already active."));
                }
                let input: Activation = serde_json::from_value(data.clone())?;
                let owned = input.owned()?;
                self.failure = None;
                self.engine = Some(
                    CaptureEngine::start(self.api()?, input.plan.clone(), &input.core_pids, owned)
                        .await?,
                );
                self.active = Some(input.plan);
                self.started = native::clock::milliseconds();
                self.status()
            }
            "reconfigure" => {
                let input: Activation = serde_json::from_value(data.clone())?;
                let owned = input.owned()?;
                self.engine
                    .as_mut()
                    .ok_or_else(|| Error::invalid("Capture is not running."))?
                    .apply(input.plan.clone(), &input.core_pids, owned)
                    .await?;
                self.active = Some(input.plan);
                self.failure = None;
                if let Some(engine) = &self.engine {
                    engine.clear_error()?;
                }
                self.status()
            }
            "status" => self.status(),
            "stop" => {
                self.stop().await?;
                self.status()
            }
            _ => Err(Error::invalid("Unknown worker operation.")),
        }
    }
    fn status(&mut self) -> Result<Value> {
        let mut packets = 0;
        let mut bytes = 0;
        let mut options = Value::Null;
        let mut failed = false;
        if let Some(engine) = &self.engine {
            if let Some(error) = engine.failure()? {
                self.failure = Some(error.0);
                failed = true;
            } else if let Some(error) = engine.last_error()? {
                self.failure = Some(error.0);
            }
            (packets, bytes) = engine.counts();
            options = serde_json::to_value(engine.interfaces()?)?;
        }
        Ok(
            json!({"state":if self.engine.is_none(){"stopped"}else if failed{"failed"}else{"running"},"mode":"routing","packets":packets,"bytes":bytes,"uptimeSeconds":if self.engine.is_some(){native::clock::milliseconds().saturating_sub(self.started)/1000}else{0},"inputs":self.active.as_ref().map(|p|p.inputs.iter().map(|i|i.tag.clone()).collect::<Vec<_>>()).unwrap_or_default(),"interfaces":options,"firewallManaged":self.engine.is_some(),"lastError":self.failure}),
        )
    }
    pub async fn stop(&mut self) -> Result<()> {
        let mut errors = Vec::new();
        if let Some(mut app) = self.applications.take() {
            if let Err(error) = app.close().await {
                errors.push(error);
            }
        }
        if let Some(mut engine) = self.engine.take() {
            if let Err(error) = engine.close().await {
                errors.push(error);
            }
        }
        self.active = None;
        if errors.is_empty() {
            Ok(())
        } else {
            Err(Error::invalid(
                errors
                    .iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
                    .join(" Cleanup: "),
            ))
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Activation {
    plan: Plan,
    core_pids: Vec<u32>,
    excluded_interfaces: Vec<String>,
}
impl Activation {
    fn owned(&self) -> Result<Vec<String>> {
        if self.excluded_interfaces.len() > 2
            || self.excluded_interfaces.iter().enumerate().any(|(i, id)| {
                id.len() != 36
                    || crate::sharing::canonical_id(id).is_none()
                    || id == "00000000-0000-0000-0000-000000000000"
                    || self.excluded_interfaces[..i]
                        .iter()
                        .any(|other| text::equal(other, id))
            })
        {
            return Err(Error::invalid("Invalid owned capture interfaces."));
        }
        Ok(self.excluded_interfaces.clone())
    }
}
fn owner_sid(data: &Value) -> Result<&str> {
    data.get("ownerSid")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| Error::invalid("Missing installation owner SID."))
}
fn catalog(owner: &str) -> Result<Value> {
    native::observation::enable()?;
    let windows = native::processes::windows_directory()?;
    let prefix = format!("{}\\", windows.trim_end_matches(['\\', '/']));
    let mut snapshot = native::processes::ProcessSnapshot::default();
    let processes = snapshot
        .read(false)?
        .into_iter()
        .filter(|p| {
            p.exited.is_none()
                && !text::protected(&p.name)
                && ![
                    "System",
                    "System Idle Process",
                    "Secure System",
                    "Registry",
                    "Memory Compression",
                ]
                .iter()
                .any(|name| text::equal(text::stem(&p.name), name))
                && !p
                    .path
                    .as_ref()
                    .is_some_and(|path| text::starts_with(path, &prefix))
        })
        .map(|p| json!({"pid":p.key.pid,"name":p.name,"path":p.path}))
        .collect::<Vec<_>>();
    let services = native::service_catalog::read()?
        .into_iter()
        .map(|s| json!({"name":s.name,"displayName":s.display_name,"pid":s.pid}))
        .collect::<Vec<_>>();
    let interfaces=native::adapters::read()?.into_iter().map(|a|json!({"id":a.id,"name":a.name,"description":a.description,"status":a.status,"ipv4Index":a.ipv4_index,"ipv6Index":a.ipv6_index,"addresses":a.addresses.iter().map(|(ip,prefix)|json!({"address":ip.to_string(),"prefixLength":prefix})).collect::<Vec<_>>()})).collect::<Vec<_>>();
    Ok(
        json!({"ownerSid":owner,"packages":native::packages::read(Some(owner))?,"services":services,"interfaces":interfaces,"processes":processes}),
    )
}
