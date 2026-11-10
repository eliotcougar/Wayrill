//! Classify timezone initialization needs without loading or executing an image.
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;

// Microsoft.NET.HostModel's apphost bundle marker. Single-file hosts link
// hostfxr statically, so imports and hostfxr export-name strings cannot identify them.
const DOTNET_BUNDLE: &[u8] = b"\x8b\x12\x02\xb9\x6a\x61\x20\x38\x72\x7b\x93\x02\x14\xd7\xa0\x32\x13\xf5\xb9\xe6\xef\xae\x33\x18\xee\x3b\x2d\xce\x24\xb3\x6a\xae";

pub(super) fn node(path: &Path) -> bool {
    let node = [b"napi_get_version".as_slice(), b"node_module_register"];
    exports(path, &node).unwrap_or(false)
        // Split Electron builds put Node in chrome.dll, behind a small
        // Chromium launcher. Require both launcher exports; an arbitrary exe
        // beside an Electron installation must not inherit its runtime type.
        || (exports(path, &[b"GetHandleVerifier", b"IsSandboxedProcess"]).unwrap_or(false)
            && path.parent().is_some_and(|parent| exports(&parent.join("chrome.dll"), &node).unwrap_or(false)))
}
pub(super) fn supported(path: &Path) -> bool {
    Image::open(path)
        .and_then(|mut i| i.supported())
        .unwrap_or(false)
}
pub(super) fn cached(path: &Path) -> bool {
    Image::open(path)
        .and_then(|mut i| i.cached())
        .unwrap_or(false)
}
struct Section {
    name: [u8; 8],
    start: u32,
    size: u32,
    raw: u32,
}
struct Image {
    file: std::fs::File,
    machine: u16,
    optional: Vec<u8>,
    directory: usize,
    sections: Vec<Section>,
}
fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "Invalid application image")
}
impl Image {
    fn open(path: &Path) -> io::Result<Self> {
        let mut file = std::fs::File::open(path)?;
        let mut dos = [0; 64];
        file.read_exact(&mut dos)?;
        if &dos[..2] != b"MZ" {
            return Err(invalid());
        }
        let pe = u32::from_le_bytes(dos[60..].try_into().unwrap()) as u64;
        file.seek(SeekFrom::Start(pe))?;
        let mut header = [0; 24];
        file.read_exact(&mut header)?;
        if &header[..4] != b"PE\0\0" {
            return Err(invalid());
        }
        let count = u16::from_le_bytes(header[6..8].try_into().unwrap());
        let optional_size = u16::from_le_bytes(header[20..22].try_into().unwrap());
        if count > 96 || optional_size < 104 {
            return Err(invalid());
        }
        let mut optional = vec![0; optional_size as usize];
        file.read_exact(&mut optional)?;
        let directory = match &optional[..2] {
            [0x0b, 0x02] => 112,
            [0x0b, 0x01] => 96,
            _ => return Err(invalid()),
        };
        if optional.len() < directory + 8 {
            return Err(invalid());
        }
        let mut sections = Vec::new();
        for _ in 0..count {
            let mut section = [0; 40];
            file.read_exact(&mut section)?;
            let field = |at| u32::from_le_bytes(section[at..at + 4].try_into().unwrap());
            sections.push(Section {
                name: section[..8].try_into().unwrap(),
                start: field(12),
                size: field(16),
                raw: field(20),
            });
        }
        Ok(Self {
            file,
            machine: u16::from_le_bytes(header[4..6].try_into().unwrap()),
            optional,
            directory,
            sections,
        })
    }
    fn offset(&self, rva: u32, length: u32) -> io::Result<u64> {
        self.sections
            .iter()
            .find_map(|s| {
                let relative = rva.checked_sub(s.start)?;
                (relative.checked_add(length)? <= s.size).then_some(s.raw as u64 + relative as u64)
            })
            .ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "Export outside image section")
            })
    }
    fn directory(&self, index: usize) -> u32 {
        self.optional
            .get(self.directory + index * 8..self.directory + index * 8 + 4)
            .map_or(0, |v| u32::from_le_bytes(v.try_into().unwrap()))
    }
    fn read(&mut self, rva: u32, size: u32) -> io::Result<Vec<u8>> {
        self.file.seek(SeekFrom::Start(self.offset(rva, size)?))?;
        let mut data = vec![0; size as usize];
        self.file.read_exact(&mut data)?;
        Ok(data)
    }
    fn prefix(&mut self, rva: u32, limit: u32) -> io::Result<Vec<u8>> {
        let available = self
            .sections
            .iter()
            .find_map(|s| {
                let relative = rva.checked_sub(s.start)?;
                (relative < s.size).then(|| s.size - relative)
            })
            .ok_or_else(invalid)?;
        self.read(rva, available.min(limit))
    }
    fn supported(&mut self) -> io::Result<bool> {
        if self.machine == 0x8664 {
            return Ok(true);
        }
        let cli = self.directory(14);
        if self.machine != 0x14c || cli == 0 {
            return Ok(false);
        }
        let cli = self.read(cli, 20)?;
        let flags = u32::from_le_bytes(cli[16..20].try_into().unwrap());
        // AnyCPU IL executables without Required/Preferred32Bit run as native x64.
        Ok(flags & 1 != 0 && flags & (2 | 0x20000) == 0)
    }
    fn exports(&mut self, expected: &[&[u8]]) -> io::Result<bool> {
        if !self.supported()? {
            return Ok(false);
        }
        let export_rva = self.directory(0);
        if export_rva == 0 {
            return Ok(false);
        }
        let exports = self.read(export_rva, 40)?;
        let count = u32::from_le_bytes(exports[24..28].try_into().unwrap());
        let names = u32::from_le_bytes(exports[32..36].try_into().unwrap());
        if count > 100_000 {
            return Ok(false);
        }
        let rvas = self.read(names, count * 4)?;
        // The PE export name table is lexically sorted. Two bounded searches avoid
        // reading thousands of unrelated symbols from large Electron executables.
        for &expected in expected {
            let (mut low, mut high) = (0, count as usize);
            let mut found = false;
            while low < high {
                let mid = low + (high - low) / 2;
                let rva = u32::from_le_bytes(rvas[mid * 4..mid * 4 + 4].try_into().unwrap());
                let name = self.prefix(rva, expected.len() as u32 + 1)?;
                let end = name.iter().position(|v| *v == 0).unwrap_or(name.len());
                match name[..end].cmp(expected) {
                    std::cmp::Ordering::Less => low = mid + 1,
                    std::cmp::Ordering::Greater => high = mid,
                    std::cmp::Ordering::Equal => {
                        found = true;
                        break;
                    }
                }
            }
            if !found {
                return Ok(false);
            }
        }
        Ok(true)
    }
    fn cached(&mut self) -> io::Result<bool> {
        if !self.supported()? {
            return Ok(false);
        }
        if self.directory(14) != 0 {
            return Ok(true);
        }
        let mut import = self.directory(1);
        for _ in 0..256 {
            if import == 0 {
                break;
            }
            let row = self.read(import, 20)?;
            let name = u32::from_le_bytes(row[12..16].try_into().unwrap());
            if name == 0 {
                break;
            }
            let name = self.prefix(name, 64)?;
            let name = String::from_utf8_lossy(
                &name[..name.iter().position(|v| *v == 0).unwrap_or(name.len())],
            )
            .to_ascii_lowercase();
            let python = name
                .strip_prefix("python")
                .and_then(|v| v.strip_suffix(".dll"))
                .is_some_and(|v| {
                    v.starts_with('3')
                        && v.trim_end_matches("_d").bytes().all(|b| b.is_ascii_digit())
                });
            if python
                || matches!(
                    name.as_str(),
                    "jli.dll" | "jvm.dll" | "qt5core.dll" | "qt6core.dll"
                )
            {
                return Ok(true);
            }
            import = import.checked_add(20).ok_or_else(invalid)?;
        }
        for index in 0..self.sections.len() {
            let s = &self.sections[index];
            let size = s.size.min(256 * 1024);
            let rva = s.start;
            let data = s.name.starts_with(b".data") || s.name.starts_with(b".go.buil");
            let strings = s.name.starts_with(b".rdata");
            if data || strings {
                let bytes = self.read(rva, size)?;
                if data
                    && (bytes
                        .chunks(16)
                        .any(|v| v.starts_with(b"\xff Go buildinf:"))
                        || bytes
                            .windows(DOTNET_BUNDLE.len())
                            .any(|v| v == DOTNET_BUNDLE))
                {
                    return Ok(true);
                }
                if strings
                    && [
                        b"hostfxr_main_startupinfo".as_slice(),
                        b"JNI_CreateJavaVM",
                        b"JLI_Launch",
                    ]
                    .iter()
                    .any(|marker| bytes.windows(marker.len()).any(|v| v == *marker))
                {
                    return Ok(true);
                }
            }
        }
        self.exports(&[b"DotNetRuntimeDebugHeader"])
    }
}
fn exports(path: &Path, expected: &[&[u8]]) -> io::Result<bool> {
    Image::open(path)?.exports(expected)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn detects_x64_node_exports_in_standalone_and_split_images() {
        let directory = std::env::temp_dir().join(format!(
            "wayrill-image-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("Chat.exe");
        let mut bytes = vec![0; 1024];
        bytes[..2].copy_from_slice(b"MZ");
        bytes[60..64].copy_from_slice(&128u32.to_le_bytes());
        bytes[128..134].copy_from_slice(b"PE\0\0\x64\x86");
        bytes[134..136].copy_from_slice(&1u16.to_le_bytes());
        bytes[148..150].copy_from_slice(&240u16.to_le_bytes());
        bytes[152..154].copy_from_slice(&[0x0b, 0x02]);
        bytes[264..268].copy_from_slice(&0x1000u32.to_le_bytes());
        for (at, value) in [
            (404, 0x1000u32),
            (408, 512),
            (412, 512),
            (536, 2),
            (544, 0x1030),
            (560, 0x1040),
            (564, 0x1060),
        ] {
            bytes[at..at + 4].copy_from_slice(&value.to_le_bytes());
        }
        bytes[576..593].copy_from_slice(b"napi_get_version\0");
        bytes[608..629].copy_from_slice(b"node_module_register\0");
        let original = bytes.clone();
        std::fs::write(&path, &bytes).unwrap();
        assert!(node(&path));
        bytes[608] = b'z';
        std::fs::write(&path, &bytes).unwrap();
        assert!(!node(&path));
        bytes[608] = b'n';
        bytes[132..134].copy_from_slice(&[0x4c, 0x01]);
        std::fs::write(&path, &bytes).unwrap();
        assert!(!node(&path));
        std::fs::write(&path, &bytes[..70]).unwrap();
        assert!(!node(&path));
        std::fs::write(directory.join("chrome.dll"), original.clone()).unwrap();
        // A split build's launcher has no Node exports of its own.
        bytes = original;
        bytes[576..640].fill(0);
        bytes[576..594].copy_from_slice(b"GetHandleVerifier\0");
        bytes[608..627].copy_from_slice(b"IsSandboxedProcess\0");
        std::fs::write(&path, &bytes).unwrap();
        assert!(node(&path));
        bytes[576] = b'H';
        std::fs::write(&path, &bytes).unwrap();
        assert!(!node(&path));
        std::fs::remove_file(path).unwrap();
        std::fs::remove_file(directory.join("chrome.dll")).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn anycpu_flags_and_short_imports_at_a_later_section_boundary_are_resolved() {
        let path = std::env::temp_dir().join(format!(
            "wayrill-runtime-{}-{}.exe",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut bytes = vec![0; 1024];
        bytes[..2].copy_from_slice(b"MZ");
        bytes[60..64].copy_from_slice(&128u32.to_le_bytes());
        bytes[128..134].copy_from_slice(b"PE\0\0\x4c\x01");
        bytes[134..136].copy_from_slice(&1u16.to_le_bytes());
        bytes[148..150].copy_from_slice(&240u16.to_le_bytes());
        bytes[152..154].copy_from_slice(&[0x0b, 0x01]);
        for (at, value) in [(360, 0x1100u32), (404, 0x1000), (408, 512), (412, 512)] {
            bytes[at..at + 4].copy_from_slice(&value.to_le_bytes());
        }
        for (flags, expected) in [(1u32, true), (3, false), (0x20001, false), (0, false)] {
            bytes[784..788].copy_from_slice(&flags.to_le_bytes());
            std::fs::write(&path, &bytes).unwrap();
            assert_eq!(supported(&path), expected, "CLI flags {flags:#x}");
            assert_eq!(cached(&path), expected);
        }
        bytes[132..134].copy_from_slice(&0x8664u16.to_le_bytes());
        bytes[134..136].copy_from_slice(&2u16.to_le_bytes());
        bytes[152..154].copy_from_slice(&[0x0b, 0x02]);
        for (at, value) in [
            (272, 0x1000u32),
            (408, 256),
            (444, 0x2000),
            (448, 256),
            (452, 768),
            (524, 0x20f4),
        ] {
            bytes[at..at + 4].copy_from_slice(&value.to_le_bytes());
        }
        bytes[1012..1024].copy_from_slice(b"Qt6Core.dll\0");
        std::fs::write(&path, &bytes).unwrap();
        assert!(cached(&path));
        bytes[272..276].fill(0);
        bytes[392..400].copy_from_slice(b".data\0\0\0");
        bytes[600..632].copy_from_slice(DOTNET_BUNDLE);
        std::fs::write(&path, &bytes).unwrap();
        assert!(cached(&path));
        std::fs::remove_file(path).unwrap();
    }
}
