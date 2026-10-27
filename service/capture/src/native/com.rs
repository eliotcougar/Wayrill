// SPDX-License-Identifier: GPL-3.0-only
//! Small ownership wrappers for the fixed Windows firewall/ICS interfaces.
use crate::{Error, Result};
use std::{marker::PhantomData, rc::Rc};
use windows::{
    core::{IUnknown, Interface},
    Win32::{
        Foundation::RPC_E_CHANGED_MODE,
        System::{
            Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_MULTITHREADED},
            Ole::IEnumVARIANT,
            Variant::{VariantClear, VARIANT, VT_DISPATCH, VT_UNKNOWN},
        },
    },
};

#[cfg(feature = "windivert")]
use windows::{
    core::BSTR,
    Win32::System::{
        Ole::{SafeArrayGetDim, SafeArrayGetElement, SafeArrayGetLBound, SafeArrayGetUBound},
        Variant::{VT_ARRAY, VT_BSTR, VT_EMPTY, VT_NULL},
    },
};
pub(super) struct Apartment {
    initialized: bool,
    _thread: PhantomData<Rc<()>>,
}
impl Apartment {
    pub fn sta() -> Result<Self> {
        // SAFETY: used only by the dedicated ICS thread. Reject an incompatible
        // existing apartment instead of silently changing its threading model.
        unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;
        }
        Ok(Self {
            initialized: true,
            _thread: PhantomData,
        })
    }
    pub fn enter() -> Result<Self> {
        // SAFETY: initializes only this thread. An existing STA is also valid
        // for the firewall interfaces and must not be uninitialized by us.
        let code = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if code != RPC_E_CHANGED_MODE {
            code.ok()?;
        }
        Ok(Self {
            initialized: code != RPC_E_CHANGED_MODE,
            _thread: PhantomData,
        })
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        if self.initialized {
            // SAFETY: one balanced call for our successful S_OK/S_FALSE initialization;
            // !Send/!Sync keeps this guard on the original thread.
            unsafe {
                CoUninitialize();
            }
        }
    }
}
pub(super) struct Variant(pub VARIANT);
impl Drop for Variant {
    fn drop(&mut self) {
        // SAFETY: sole owned VARIANT, initialized by default or a successful COM
        // output. No contained BSTR/interface/SAFEARRAY is separately released.
        unsafe {
            let _ = VariantClear(&mut self.0);
        }
    }
}
impl Variant {
    pub fn interface<T: Interface>(&self) -> Result<T> {
        // SAFETY: native discriminators select only owned interface members;
        // QueryInterface creates an independent reference before VariantClear.
        unsafe {
            let value = &self.0.Anonymous.Anonymous;
            if value.vt == VT_DISPATCH {
                return Ok(value
                    .Anonymous
                    .pdispVal
                    .as_ref()
                    .ok_or_else(|| Error::invalid("Missing COM enumeration interface."))?
                    .cast()?);
            }
            if value.vt == VT_UNKNOWN {
                return Ok(value
                    .Anonymous
                    .punkVal
                    .as_ref()
                    .ok_or_else(|| Error::invalid("Missing COM enumeration interface."))?
                    .cast()?);
            }
            Err(Error::invalid("Unexpected COM enumeration value."))
        }
    }
    #[cfg(feature = "windivert")]
    pub fn interface_names(&self) -> Result<String> {
        // SAFETY: all union reads are guarded by the native VARTYPE. SAFEARRAY
        // dimensions/bounds are checked and every copied BSTR is owned locally.
        unsafe {
            let value = &self.0.Anonymous.Anonymous;
            if value.vt == VT_EMPTY || value.vt == VT_NULL {
                return Ok(String::new());
            }
            if value.vt == VT_BSTR {
                return Ok(value.Anonymous.bstrVal.to_string());
            }
            if value.vt.0 != VT_ARRAY.0 | VT_BSTR.0 {
                return Err(Error::invalid("Unexpected firewall interface scope."));
            }
            let array = value.Anonymous.parray;
            if array.is_null() || SafeArrayGetDim(array) != 1 {
                return Err(Error::invalid("Invalid firewall interface array."));
            }
            let (low, high) = (SafeArrayGetLBound(array, 1)?, SafeArrayGetUBound(array, 1)?);
            if i64::from(high) - i64::from(low) > 65536 {
                return Err(Error::invalid("Firewall interface scope exceeds capacity."));
            }
            let mut names = Vec::new();
            for index in low..=high {
                let mut text = BSTR::default();
                SafeArrayGetElement(array, &index, (&mut text as *mut BSTR).cast())?;
                names.push(text.to_string());
            }
            names.sort_by(|a, b| crate::text::ordinal_compare(a, b));
            Ok(names.join(","))
        }
    }
}
pub(super) struct Enumeration {
    native: IEnumVARIANT,
    remaining: usize,
}
impl Enumeration {
    pub fn new(value: IUnknown) -> Result<Self> {
        Ok(Self {
            native: value.cast()?,
            remaining: 100000,
        })
    }
}
impl Iterator for Enumeration {
    type Item = Result<Variant>;
    fn next(&mut self) -> Option<Self::Item> {
        let mut value = Variant(VARIANT::default());
        let mut count = 0;
        // SAFETY: one initialized owned VARIANT and a valid fetched-count output.
        let code = unsafe {
            self.native
                .Next(std::slice::from_mut(&mut value.0), &mut count)
        };
        if let Err(error) = code.ok() {
            return Some(Err(error.into()));
        }
        if count == 0 {
            return None;
        }
        if self.remaining == 0 {
            return Some(Err(Error::invalid("COM inventory exceeds capacity.")));
        }
        self.remaining -= 1;
        Some(Ok(value))
    }
}
