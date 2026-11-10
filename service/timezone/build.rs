fn main() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(
        "../../.tools/timezone-build/Detours-e4bfd6b03e50de46b47abfbd1e46b384f0c5f833/lib.X64",
    );
    if !root.join("detours.lib").is_file() {
        panic!("Prepare Microsoft Detours with tools/Build-Timezone.ps1 -PrepareOnly, or use tools/Check-Native.ps1.");
    }
    println!("cargo:rustc-link-search=native={}", root.display());
    println!(
        "cargo:rerun-if-changed={}",
        root.join("detours.lib").display()
    );
}
