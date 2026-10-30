// SPDX-License-Identifier: GPL-3.0-only
//! System observation and TUN attribution; no packet interception capability.
use crate::{
    native, text,
    tun_applications::{TunApplications, TunInput},
    wire::Command,
    Error, Result,
};
use serde_json::{json, Value};

#[derive(Default)]
pub struct Companion {
    applications: Option<TunApplications>,
}
impl Companion {
    pub async fn command(
        &mut self,
        request: Command<'_>,
        progress: &mut crate::sharing::Report<'_>,
    ) -> Result<Value> {
        let data = request.data;
        match request.method {
            "sharing.inspect" => Ok(serde_json::to_value(native::sharing::inspect(progress)?)?),
            "sharing.set" => Ok(serde_json::to_value(native::sharing::change(
                serde_json::from_value(data.clone())?,
                progress,
            )?)?),
            "catalog" => catalog(owner_sid(data)?),
            "policy.evaluate" => crate::policy::evaluate(data),
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

            "applications.start" => {
                if self.applications.is_some() {
                    return Err(Error::invalid("Attribution is already active."));
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
            "stop" => {
                self.stop().await?;
                Ok(json!({"state":"stopped"}))
            }
            _ => Err(Error::invalid("Unknown attribution operation.")),
        }
    }
    pub async fn stop(&mut self) -> Result<()> {
        if let Some(mut app) = self.applications.take() {
            app.close().await?;
        }
        Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn packet_capture_operations_are_not_part_of_the_companion_protocol() {
        let mut companion = Companion::default();
        for method in ["start", "reconfigure", "check", "firewall.clear"] {
            assert!(companion
                .command(
                    Command {
                        id: 1,
                        method,
                        data: &json!({})
                    },
                    &mut |_| Ok(())
                )
                .await
                .is_err());
        }
        assert!(companion.stop().await.is_ok());
    }
}
