//! Existing RoutingService RPCs over Control's authenticated loopback SOCKS input.
use super::Control;
use hyper_util::rt::TokioIo;
use std::{io, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
};
use tonic::{
    client::Grpc,
    transport::{Channel, Endpoint},
    Request,
};
use wayrill_protocol::{ApiError, Result};

#[derive(Clone, PartialEq, prost::Message)]
struct Query {
    #[prost(string, tag = "1")]
    tag: String,
}
#[derive(Clone, PartialEq, prost::Message)]
struct Reply {
    #[prost(message, optional, tag = "1")]
    balancer: Option<Balancer>,
}
#[derive(Clone, PartialEq, prost::Message)]
struct Balancer {
    #[prost(message, optional, tag = "5")]
    override_target: Option<Override>,
    #[prost(message, optional, tag = "6")]
    principle_target: Option<Principle>,
}
#[derive(Clone, PartialEq, prost::Message)]
struct Override {
    #[prost(string, tag = "2")]
    target: String,
}
#[derive(Clone, PartialEq, prost::Message)]
struct Principle {
    #[prost(string, repeated, tag = "1")]
    tag: Vec<String>,
}
#[derive(Clone, PartialEq, prost::Message)]
struct SetTarget {
    #[prost(string, tag = "1")]
    balancer_tag: String,
    #[prost(string, tag = "2")]
    target: String,
}
#[derive(Clone, PartialEq, prost::Message)]
struct Empty {}

pub(crate) struct Selection {
    pub override_target: String,
    pub candidates: Vec<String>,
}
impl From<Balancer> for Selection {
    fn from(value: Balancer) -> Self {
        Self {
            override_target: value.override_target.map(|v| v.target).unwrap_or_default(),
            // leastPing reports [""] before a probe succeeds, not an empty list.
            candidates: value
                .principle_target
                .map(|v| v.tag)
                .unwrap_or_default()
                .into_iter()
                .filter(|tag| !tag.is_empty())
                .collect(),
        }
    }
}
fn failed() -> ApiError {
    ApiError::new(
        "OUTBOUND_TEST",
        "Cannot read Xray policy selection; the running configuration may have changed.",
    )
}

impl Control {
    async fn selection_channel(&self) -> Result<Grpc<Channel>> {
        let address = self.address.clone();
        let password = self.password.clone();
        let endpoint = Endpoint::from_static("http://127.0.0.1")
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(2));
        let channel = endpoint
            .connect_with_connector(tower::service_fn(move |_| {
                let address = address.clone();
                let password = password.clone();
                async move { socks(&address, &password).await.map(TokioIo::new) }
            }))
            .await
            .map_err(|_| failed())?;
        Ok(Grpc::new(channel).max_decoding_message_size(4 * 1024 * 1024))
    }
    pub(crate) async fn balancer_selection(&self, tag: &str) -> Result<Selection> {
        tokio::time::timeout(Duration::from_secs(2), async {
            let mut client = self.selection_channel().await?;
            client.ready().await.map_err(|_| failed())?;
            let mut query = Request::new(Query {
                tag: tag.to_owned(),
            });
            query.set_timeout(Duration::from_secs(2));
            let reply: tonic::Response<Reply> = client
                .unary(
                    query,
                    tonic::codegen::http::uri::PathAndQuery::from_static(
                        "/xray.app.router.command.RoutingService/GetBalancerInfo",
                    ),
                    tonic_prost::ProstCodec::default(),
                )
                .await
                .map_err(|_| failed())?;
            let balancer = reply.into_inner().balancer.ok_or_else(failed)?;
            Ok(balancer.into())
        })
        .await
        .map_err(|_| failed())?
    }
    /// Used only on an isolated test core, never on the active routing core.
    pub(crate) async fn pin_test_balancer(&self, tag: &str, target: &str) -> Result<()> {
        tokio::time::timeout(Duration::from_secs(2), async {
            let mut client = self.selection_channel().await?;
            client.ready().await.map_err(|_| failed())?;
            let mut query = Request::new(SetTarget {
                balancer_tag: tag.to_owned(),
                target: target.to_owned(),
            });
            query.set_timeout(Duration::from_secs(2));
            let _: tonic::Response<Empty> = client
                .unary(
                    query,
                    tonic::codegen::http::uri::PathAndQuery::from_static(
                        "/xray.app.router.command.RoutingService/OverrideBalancerTarget",
                    ),
                    tonic_prost::ProstCodec::default(),
                )
                .await
                .map_err(|_| failed())?;
            Ok(())
        })
        .await
        .map_err(|_| failed())?
    }
}

async fn socks(address: &str, password: &str) -> io::Result<TcpStream> {
    let mut stream = TcpStream::connect(address).await?;
    stream.set_nodelay(true)?;
    stream.write_all(&[5, 1, 2]).await?;
    let mut response = [0; 2];
    stream.read_exact(&mut response).await?;
    if response != [5, 2] {
        return Err(io::Error::other("Private core authentication required."));
    }
    let mut auth = vec![1, 7];
    auth.extend_from_slice(b"wayrill");
    auth.push(password.len() as u8);
    auth.extend_from_slice(password.as_bytes());
    stream.write_all(&auth).await?;
    stream.read_exact(&mut response).await?;
    if response != [1, 0] {
        return Err(io::Error::other("Private core authentication failed."));
    }
    stream.write_all(&[5, 1, 0, 1, 127, 0, 0, 1, 0, 1]).await?;
    let mut bound = [0; 4];
    stream.read_exact(&mut bound).await?;
    if bound[0..3] != [5, 0, 0] {
        return Err(io::Error::other("Private core connection failed."));
    }
    let size = match bound[3] {
        1 => 4,
        4 => 16,
        3 => stream.read_u8().await? as usize,
        _ => return Err(io::Error::other("Invalid private core address.")),
    };
    let mut tail = vec![0; size + 2];
    stream.read_exact(&mut tail).await?;
    Ok(stream)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn the_upstream_least_ping_empty_marker_is_not_a_ready_member() {
        let selection = Selection::from(Balancer {
            override_target: None,
            principle_target: Some(Principle {
                tag: vec![String::new()],
            }),
        });
        assert!(selection.candidates.is_empty());
        assert!(selection.override_target.is_empty());
    }
}
