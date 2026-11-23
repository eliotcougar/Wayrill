use super::state::{Action, Command};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{future::Future, time::Duration};
use tokio::time::{sleep, timeout, Instant};
use wayrill_protocol::{ApiError, Result};

const RECEIPT_TIMEOUT: Duration = Duration::from_secs(5);
const CONNECTION_GRACE: Duration = Duration::from_secs(60);

#[derive(Debug)]
pub(super) enum Failure {
    Rejected(ApiError),
    Unconfirmed(ApiError),
}

#[derive(Deserialize)]
#[serde(tag = "state", rename_all = "camelCase")]
enum Receipt {
    Pending,
    Succeeded,
    Failed { error: ApiError },
    NotSubmitted,
    Unavailable,
}

fn reply_lost(error: &ApiError) -> bool {
    matches!(
        error.code.as_str(),
        "TIMEOUT" | "DISCONNECTED" | "OS_ERROR" | "INVALID_FRAME" | "FRAME_TOO_LARGE"
    )
}

fn unconfirmed(message: &str) -> Failure {
    Failure::Unconfirmed(ApiError::new("COMMAND_OUTCOME_UNAVAILABLE", message))
}

pub(super) async fn execute<F>(
    command: &Command,
    mut request: impl FnMut(&'static str, Value) -> F,
    instance_changed: impl Fn() -> bool,
    verifying: impl FnOnce(),
) -> std::result::Result<Option<Value>, Failure>
where
    F: Future<Output = Result<Value>>,
{
    let method = command.action.method();
    let mut params = match command.action {
        Action::Start => json!({"revision":command.revision}),
        Action::Stop => json!({}),
    };
    let ticket = match request(
        "service.operationPrepare",
        json!({"method":method,"instanceId":command.instance}),
    )
    .await
    {
        Ok(value) => Some(
            value["ticket"]
                .as_str()
                .filter(|id| id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit()))
                .ok_or_else(|| {
                    Failure::Rejected(ApiError::new(
                        "INVALID_FRAME",
                        "The service returned an invalid routing ticket. Try again.",
                    ))
                })?
                .to_owned(),
        ),
        Err(error) if error.code == "METHOD_NOT_FOUND" => None,
        Err(error) => return Err(Failure::Rejected(error)),
    };
    if instance_changed() {
        return Err(Failure::Rejected(ApiError::new("SERVICE_INSTANCE_CHANGED", "The service restarted before the command was sent. Check the current routing state and try again.")));
    }
    if let Some(ticket) = &ticket {
        params["ticket"] = json!(ticket);
    }
    match request(method, params).await {
        Ok(snapshot) => return Ok(Some(snapshot)),
        Err(error) if reply_lost(&error) => {}
        Err(error) => return Err(Failure::Rejected(error)),
    }
    let Some(ticket) = ticket else {
        return Err(unconfirmed(
            "The service lost its reply. Check the current routing state before trying again.",
        ));
    };
    verifying();

    let mut last_contact = Instant::now();
    loop {
        if instance_changed() {
            return Err(unconfirmed("The service restarted before the outcome could be confirmed. Check the current routing state."));
        }
        match timeout(
            RECEIPT_TIMEOUT,
            request("service.operationGet", json!({"ticket":ticket})),
        )
        .await
        {
            Ok(Ok(value)) => match serde_json::from_value::<Receipt>(value) {
                Ok(Receipt::Succeeded) => return Ok(None),
                Ok(Receipt::Failed { error }) => return Err(Failure::Rejected(error)),
                Ok(Receipt::NotSubmitted) => {
                    return Err(Failure::Rejected(ApiError::new(
                        "COMMAND_NOT_SUBMITTED",
                        "The routing command did not reach the service. You can try it again.",
                    )))
                }
                Ok(Receipt::Pending) => {
                    last_contact = Instant::now();
                    sleep(Duration::from_millis(500)).await;
                    continue;
                }
                Ok(Receipt::Unavailable) | Err(_) => break,
            },
            Ok(Err(error))
                if !reply_lost(&error)
                    && !matches!(
                        error.code.as_str(),
                        "BUSY" | "SERVICE_UNAVAILABLE" | "SERVICE_STOPPING"
                    ) =>
            {
                break
            }
            _ => {}
        }
        if last_contact.elapsed() >= CONNECTION_GRACE {
            break;
        }
        sleep(Duration::from_secs(1)).await;
    }
    Err(unconfirmed("The service could not confirm the command outcome. Check the current routing state before trying again."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::Cell, future::ready};

    const TICKET: &str = "b0dac000000000000000000000000000";

    fn command(action: Action) -> Command {
        Command {
            action,
            revision: 9,
            epoch: 1,
            instance: "service-1".into(),
        }
    }

    #[test]
    fn a_lost_start_reply_checks_the_same_ticket_until_success_without_repeating_start() {
        let mut calls = Vec::new();
        let verifying = Cell::new(false);
        let mut replies = [
            Ok(json!({"ticket": TICKET})),
            Err(ApiError::new("DISCONNECTED", "pipe closed")),
            Ok(json!({"state":"pending"})),
            Err(ApiError::new("SERVICE_UNAVAILABLE", "pipe not ready")),
            Ok(json!({"state":"succeeded"})),
        ]
        .into_iter();
        let result = tauri::async_runtime::block_on(execute(
            &command(Action::Start),
            |method, input| {
                calls.push((method, input));
                ready(replies.next().unwrap())
            },
            || false,
            || verifying.set(true),
        ));
        assert!(matches!(result, Ok(None)));
        assert!(verifying.get());
        assert_eq!(
            calls,
            [
                (
                    "service.operationPrepare",
                    json!({"method":"core.start","instanceId":"service-1"})
                ),
                ("core.start", json!({"revision":9,"ticket":TICKET})),
                ("service.operationGet", json!({"ticket":TICKET})),
                ("service.operationGet", json!({"ticket":TICKET})),
                ("service.operationGet", json!({"ticket":TICKET})),
            ]
        );
    }

    #[test]
    fn a_lost_stop_reply_reports_the_receipts_exact_error_or_non_admission() {
        for (receipt, expected) in [
            (
                json!({"state":"failed", "error":ApiError::new("ICS_KEEPER", "Restore failed")}),
                "ICS_KEEPER",
            ),
            (json!({"state":"notSubmitted"}), "COMMAND_NOT_SUBMITTED"),
        ] {
            let result = tauri::async_runtime::block_on(execute(
                &command(Action::Stop),
                |method, input| {
                    ready(match method {
                        "service.operationPrepare" => Ok(json!({"ticket":TICKET})),
                        "core.stop" => {
                            assert_eq!(input, json!({"ticket":TICKET}));
                            Err(ApiError::new("TIMEOUT", "reply timed out"))
                        }
                        "service.operationGet" => Ok(receipt.clone()),
                        other => panic!("Unexpected request {other}"),
                    })
                },
                || false,
                || {},
            ));
            assert!(matches!(result, Err(Failure::Rejected(error)) if error.code == expected));
        }
    }

    #[test]
    fn losing_the_service_instance_ends_confirmation_without_replaying_stop() {
        let restarted = Cell::new(false);
        let result = tauri::async_runtime::block_on(execute(
            &command(Action::Stop),
            |method, _| {
                ready(match method {
                    "service.operationPrepare" => Ok(json!({"ticket":TICKET})),
                    "core.stop" => Err(ApiError::new("DISCONNECTED", "pipe closed")),
                    other => panic!("Unexpected request to the replacement service: {other}"),
                })
            },
            || restarted.get(),
            || restarted.set(true),
        ));
        assert!(
            matches!(result, Err(Failure::Unconfirmed(error)) if error.message.contains("restarted"))
        );
    }

    #[test]
    fn an_older_service_can_stop_and_a_lost_legacy_reply_remains_unconfirmed() {
        for reply_lost in [false, true] {
            let result = tauri::async_runtime::block_on(execute(
                &command(Action::Stop),
                |method, params| {
                    ready(match method {
                        "service.operationPrepare" => {
                            Err(ApiError::new("METHOD_NOT_FOUND", "unsupported"))
                        }
                        "core.stop" => {
                            assert_eq!(params, json!({}));
                            if reply_lost {
                                Err(ApiError::new("DISCONNECTED", "pipe closed"))
                            } else {
                                Ok(json!({"core":{"state":"stopped"}}))
                            }
                        }
                        other => panic!("Unexpected request: {other}"),
                    })
                },
                || false,
                || panic!("Legacy service did not issue a ticket"),
            ));
            if reply_lost {
                assert!(matches!(result, Err(Failure::Unconfirmed(_))));
            } else {
                assert!(
                    matches!(result, Ok(Some(snapshot)) if snapshot["core"]["state"] == "stopped")
                );
            }
        }
    }
}
