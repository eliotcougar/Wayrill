#[repr(C)]
pub struct Policy {
    pub version: u32,
    pub enabled: u32,
    pub revision: u64,
    pub zone: [u16; 128],
}
const _: () = assert!(std::mem::size_of::<Policy>() == 272);
