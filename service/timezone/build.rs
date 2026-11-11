fn main() {
    let architecture = match std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("x86_64") => "X64",
        Ok("x86") => "X86",
        _ => panic!("Timezone components require an x64 or x86 Windows target."),
    };
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../.tools/timezone-build/Detours-e4bfd6b03e50de46b47abfbd1e46b384f0c5f833")
        .join(format!("lib.{architecture}"));
    for name in ["detours.lib", "wayrill-detours-allocator.lib"] {
        let library = root.join(name);
        if !library.is_file() {
            panic!("Prepare Microsoft Detours with tools/Build-Timezone.ps1 -PrepareOnly, or use tools/Check-Native.ps1.");
        }
        println!("cargo:rerun-if-changed={}", library.display());
    }
    println!("cargo:rustc-link-search=native={}", root.display());
}
