// SPDX-License-Identifier: GPL-3.0-only
//! Read-only fixed local CIM query, on its own cancellable COM thread.
use super::com::{Apartment, Variant};
use crate::{
    address::Address,
    nat_sessions::{Index, Session},
    packet::Flow,
    Error, Result,
};
use std::{
    net::IpAddr,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use windows::{
    core::{w, BSTR, PCWSTR},
    Win32::System::{
        Com::{
            CoCancelCall, CoCreateInstance, CoDisableCallCancellation, CoEnableCallCancellation,
            CoSetProxyBlanket, CLSCTX_INPROC_SERVER, EOAC_NONE, RPC_C_AUTHN_LEVEL_CALL,
            RPC_C_IMP_LEVEL_IMPERSONATE,
        },
        Threading::GetCurrentThreadId,
        Variant::{VT_BSTR, VT_I4, VT_UI4},
        Wmi::{
            IWbemClassObject, IWbemLocator, IWbemServices, WbemLocator,
            WBEM_FLAG_CONNECT_USE_MAX_WAIT, WBEM_FLAG_FORWARD_ONLY, WBEM_FLAG_RETURN_IMMEDIATELY,
        },
    },
};

#[derive(Default)]
struct Registration {
    thread: Option<u32>,
    stopped: bool,
}
#[derive(Clone, Default)]
pub struct Cancellation(Arc<Mutex<Registration>>);
impl Cancellation {
    pub fn cancel(&self) {
        if let Ok(mut registration) = self.0.lock() {
            registration.stopped = true;
            if let Some(id) = registration.thread {
                // SAFETY: the registration lock keeps this enabled COM thread alive
                // until cancellation returns; zero requests non-blocking cancellation.
                let _ = unsafe { CoCancelCall(id, 0) };
            }
        }
    }
}
pub struct Reader {
    // Interface is released before its original thread's COM apartment.
    service: Option<IWbemServices>,
    cancellation: Cancellation,
    _apartment: Apartment,
}
impl Reader {
    pub fn new(cancellation: Cancellation) -> Result<Self> {
        let apartment = Apartment::enter()?;
        // SAFETY: balanced for this dedicated COM thread, including failed construction.
        unsafe {
            CoEnableCallCancellation(None)?;
        }
        let reader = Self {
            service: None,
            cancellation,
            _apartment: apartment,
        };
        // SAFETY: obtains only this live thread's identifier; registration is cleared before exit.
        let thread_id = unsafe { GetCurrentThreadId() };
        {
            let mut registration = reader
                .cancellation
                .0
                .lock()
                .map_err(|_| Error::invalid("NAT cancellation lock poisoned."))?;
            if !registration.stopped {
                registration.thread = Some(thread_id);
            }
        }
        reader.check_running()?;
        Ok(reader)
    }
    fn check_running(&self) -> Result<()> {
        if self
            .cancellation
            .0
            .lock()
            .map_err(|_| Error::invalid("NAT cancellation lock poisoned."))?
            .stopped
        {
            Err(Error::invalid("Windows NAT inventory cancelled."))
        } else {
            Ok(())
        }
    }
    pub fn read(&mut self) -> Result<Index> {
        self.check_running()?;
        if self.service.is_none() {
            // SAFETY: fixed local namespace, current token, no credentials or mutation API;
            // all COM values remain on this reader's original apartment thread.
            let service = unsafe {
                let locator: IWbemLocator =
                    CoCreateInstance(&WbemLocator, None, CLSCTX_INPROC_SERVER)?;
                let empty = BSTR::default();
                let service = locator.ConnectServer(
                    &BSTR::from("ROOT\\StandardCimv2"),
                    &empty,
                    &empty,
                    &empty,
                    WBEM_FLAG_CONNECT_USE_MAX_WAIT.0,
                    &empty,
                    None,
                )?;
                CoSetProxyBlanket(
                    &service,
                    10,
                    0,
                    PCWSTR::null(),
                    RPC_C_AUTHN_LEVEL_CALL,
                    RPC_C_IMP_LEVEL_IMPERSONATE,
                    None,
                    EOAC_NONE,
                )?;
                service
            };
            self.service = Some(service);
        }
        // SAFETY: the constant query can only enumerate NAT session metadata.
        let records = unsafe {
            self.service.as_ref().unwrap().ExecQuery(&BSTR::from("WQL"),
            &BSTR::from("SELECT NatName,CreationTime,InternalRoutingDomainId,Protocol,InternalSourceAddress,InternalSourcePort,ExternalSourceAddress,ExternalSourcePort,ExternalDestinationAddress,ExternalDestinationPort FROM MSFT_NetNatSession"),
            WBEM_FLAG_FORWARD_ONLY|WBEM_FLAG_RETURN_IMMEDIATELY,None)?
        };
        let deadline = Instant::now() + Duration::from_millis(900);
        let mut rows = Vec::new();
        loop {
            self.check_running()?;
            if Instant::now() >= deadline {
                return Err(Error::invalid("Windows NAT inventory timed out."));
            }
            let mut objects = [None];
            let mut count = 0;
            // SAFETY: one initialized owned COM interface output and fetched-count output.
            let status = unsafe { records.Next(100, &mut objects, &mut count) };
            status.ok()?;
            if count == 0 {
                if status.0 == 1 {
                    break;
                } else {
                    continue;
                }
            }
            if rows.len() >= 65_536 {
                return Err(Error::invalid("Windows NAT inventory exceeds capacity."));
            }
            let object = objects[0]
                .take()
                .ok_or_else(|| Error::invalid("Missing NAT session row."))?;
            let protocol = number(&object, w!("Protocol"))?;
            if !matches!(protocol, 6 | 17) {
                continue;
            }
            let address = |name| -> Result<Address> {
                let ip = text(&object, name)?
                    .parse::<IpAddr>()
                    .map_err(|_| Error::invalid("Invalid NAT IP address."))?;
                Ok(Address {
                    ip: match ip {
                        IpAddr::V6(v) => v.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(ip),
                        _ => ip,
                    },
                    scope: 0,
                })
            };
            rows.push(Session {
                external: Flow {
                    protocol: protocol as u8,
                    local: address(w!("ExternalSourceAddress"))?,
                    local_port: port(&object, w!("ExternalSourcePort"))?,
                    remote: address(w!("ExternalDestinationAddress"))?,
                    remote_port: port(&object, w!("ExternalDestinationPort"))?,
                },
                source: address(w!("InternalSourceAddress"))?,
                source_port: port(&object, w!("InternalSourcePort"))?,
                identity: format!(
                    "{}/{}/{}",
                    text(&object, w!("InternalRoutingDomainId"))?,
                    text(&object, w!("NatName"))?,
                    text(&object, w!("CreationTime"))?
                ),
            });
        }
        Index::new(rows)
    }
}
impl Drop for Reader {
    fn drop(&mut self) {
        self.service = None;
        if let Ok(mut registration) = self.cancellation.0.lock() {
            registration.thread = None;
        }
        // SAFETY: balances successful initialization on this original thread.
        let _ = unsafe { CoDisableCallCancellation(None) };
    }
}
fn value(object: &IWbemClassObject, name: PCWSTR) -> Result<Variant> {
    let mut value = Variant(Default::default());
    // SAFETY: typed borrowed interface, fixed property name, initialized owned VARIANT output.
    unsafe {
        object.Get(name, 0, &mut value.0, None, None)?;
    }
    Ok(value)
}
fn text(object: &IWbemClassObject, name: PCWSTR) -> Result<String> {
    let value = value(object, name)?;
    // SAFETY: native VARTYPE is checked before reading the owned BSTR union member.
    unsafe {
        let inner = &value.0.Anonymous.Anonymous;
        if inner.vt != VT_BSTR {
            return Err(Error::invalid("Invalid NAT text property."));
        }
        Ok(inner.Anonymous.bstrVal.to_string())
    }
}
fn number(object: &IWbemClassObject, name: PCWSTR) -> Result<u32> {
    let value = value(object, name)?;
    // SAFETY: only matching integer VARTYPE members are read; signed values are checked.
    unsafe {
        let inner = &value.0.Anonymous.Anonymous;
        if inner.vt == VT_UI4 {
            Ok(inner.Anonymous.ulVal)
        } else if inner.vt == VT_I4 {
            u32::try_from(inner.Anonymous.lVal)
                .map_err(|_| Error::invalid("Negative NAT port/protocol."))
        } else {
            Err(Error::invalid("Invalid NAT numeric property."))
        }
    }
}
fn port(object: &IWbemClassObject, name: PCWSTR) -> Result<u16> {
    u16::try_from(number(object, name)?)
        .ok()
        .filter(|v| *v != 0)
        .ok_or_else(|| Error::invalid("Invalid NAT port."))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancelled_reader_cannot_register_after_stop() {
        let cancellation = Cancellation::default();
        cancellation.cancel();
        assert!(Reader::new(cancellation.clone()).is_err());
        assert!(cancellation.0.lock().unwrap().thread.is_none());
    }
}
