//! Authenticated GetPools probes use the same RPC as core readiness. A dedicated
//! worker owns one reusable channel; kernel health checks never block on I/O.
use super::usage::{PoolUsage, Usage};
use super::{failure, prefixes, valid_endpoint};
use serde_json::Value;
use std::{
    sync::{mpsc, Arc, Mutex},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tokio::sync::oneshot;
use tonic::{client::Grpc, transport::Endpoint, Request};
use wayrill_protocol::{ApiError, Result};

// Wire contract: app/dns/fakedns/command/command.proto in the pinned core patch.
#[derive(Clone, PartialEq, prost::Message)]
struct GetPoolsRequest {}
#[derive(Clone, PartialEq, prost::Message)]
struct GetPoolsResponse {
    #[prost(string, repeated, tag = "1")]
    ip_pools: Vec<String>,
    #[prost(message, repeated, tag = "2")]
    usage: Vec<PoolUsage>,
}

const DEADLINE: Duration = Duration::from_secs(1);
const INTERVAL: Duration = Duration::from_secs(5);

pub(super) struct Monitor {
    error: Arc<Mutex<Option<ApiError>>>,
    usage: Arc<Mutex<Option<(Instant, Usage)>>>,
    stop: Option<oneshot::Sender<()>>,
    worker: Option<JoinHandle<()>>,
}

impl Monitor {
    pub(super) fn start(endpoint: &str, pools: &Value) -> Result<Self> {
        if !valid_endpoint(endpoint) {
            return Err(failure("Invalid shared FakeDNS endpoint."));
        }
        let expected = prefixes(pools)?;
        let (address, secret) = endpoint.rsplit_once(':').unwrap();
        let target = Endpoint::from_shared(format!("http://{address}"))
            .map_err(|_| failure("Invalid shared FakeDNS endpoint."))?
            .connect_timeout(DEADLINE)
            .timeout(DEADLINE);
        let credential = secret
            .parse::<tonic::metadata::MetadataValue<_>>()
            .map_err(|_| failure("Invalid shared FakeDNS credential."))?;
        let error = Arc::new(Mutex::new(None));
        let state = error.clone();
        let usage = Arc::new(Mutex::new(None));
        let occupancy = usage.clone();
        let (stop, mut stopped) = oneshot::channel();
        let (ready, readiness) = mpsc::sync_channel(1);
        let worker = thread::Builder::new()
            .name("wayrill-fakedns-health".into())
            .spawn(move || {
                let result = (|| {
                    let runtime = tokio::runtime::Builder::new_current_thread()
                        .enable_all()
                        .build()
                        .map_err(|_| failure("Cannot start shared FakeDNS health monitor."))?;
                    runtime.block_on(async {
                        // Lazy transport reconnects itself; neither this monitor nor
                        // a mapping client has authority to restart a process.
                        let mut client = Grpc::new(target.connect_lazy())
                            .max_decoding_message_size(32768);
                        let mut failures = 0;
                        let mut first = true;
                        loop {
                            let probe = async {
                                client.ready().await.map_err(|_| failure("Shared FakeDNS gRPC channel is unavailable."))?;
                                let mut request = Request::new(GetPoolsRequest {});
                                request.set_timeout(DEADLINE);
                                request.metadata_mut().insert("x-wayrill-auth", credential.clone());
                                let response: tonic::Response<GetPoolsResponse> = client
                                    .unary(request,
                                        tonic::codegen::http::uri::PathAndQuery::from_static("/xray.app.dns.fakedns.command.FakeDNSService/GetPools"),
                                        tonic_prost::ProstCodec::default())
                                    .await.map_err(|status| failure(format!("Shared FakeDNS gRPC probe failed ({:?}).", status.code())))?;
                                let response = response.into_inner();
                                if response.ip_pools != expected {
                                    return Err(failure("Shared FakeDNS pools changed unexpectedly."));
                                }
                                // Occupancy is optional diagnostics, not a readiness condition.
                                let usage = if response.usage.iter().map(|p| p.ip_pool.clone()).collect::<Vec<_>>() == expected {
                                    Usage::new(response.usage)
                                } else { None };
                                *occupancy.lock().unwrap() = usage.map(|u| (Instant::now(), u));
                                Ok(())
                            };
                            let result = tokio::select! {
                                _ = &mut stopped => return Ok(()),
                                result = tokio::time::timeout(DEADLINE, probe) => result.unwrap_or_else(|_| Err(failure("Shared FakeDNS gRPC probe timed out."))),
                            };
                            if first {
                                let _ = ready.send(result.clone());
                                first = false;
                                result?;
                            } else if let Err(error) = result {
                                failures += 1;
                                if failures >= 3 {
                                    return Err(error);
                                }
                            } else {
                                failures = 0;
                            }
                            tokio::select! {
                                _ = &mut stopped => return Ok(()),
                                _ = tokio::time::sleep(INTERVAL) => {},
                            }
                        }
                    })
                })();
                if let Err(error) = result {
                    *state.lock().unwrap() = Some(error);
                }
            })
            .map_err(|_| failure("Cannot start shared FakeDNS health worker."))?;
        let monitor = Self {
            error,
            usage,
            stop: Some(stop),
            worker: Some(worker),
        };
        readiness
            .recv_timeout(Duration::from_secs(2))
            .map_err(|_| failure("Shared FakeDNS gRPC did not become ready."))??;
        Ok(monitor)
    }

    pub(super) fn check(&self) -> Result<()> {
        if let Some(error) = self.error.lock().unwrap().clone() {
            return Err(error);
        }
        if self
            .worker
            .as_ref()
            .is_some_and(|worker| worker.is_finished())
        {
            return Err(failure("Shared FakeDNS health monitor ended unexpectedly."));
        }
        Ok(())
    }
    pub(super) fn usage(&self) -> Option<Usage> {
        if self.check().is_err() {
            return None;
        }
        self.usage
            .lock()
            .unwrap()
            .as_ref()
            .filter(|(sampled, _)| sampled.elapsed() < Duration::from_secs(11))
            .map(|(_, usage)| usage.clone())
    }
}

impl Drop for Monitor {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() {
            let _ = stop.send(());
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
