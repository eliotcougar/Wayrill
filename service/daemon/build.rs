use std::{env, fs, path::PathBuf, process::Command};
fn main() {
    let root = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("../..");
    let manifest = root.join("service/dependencies.json");
    println!("cargo:rerun-if-changed={}", manifest.display());
    let pins: serde_json::Value = serde_json::from_slice(
        &fs::read(manifest).expect("The pinned dependency manifest is required"),
    )
    .expect("The pinned dependency manifest must be valid JSON");
    let version = pins["xray"]["version"]
        .as_str()
        .expect("Xray version missing");
    let hash = pins["xray"]["executableSha256"]
        .as_str()
        .expect("Xray SHA-256 missing");
    assert!(
        !version.is_empty() && version.bytes().all(|b| b.is_ascii_digit() || b == b'.'),
        "Invalid Xray version"
    );
    assert!(
        hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit()),
        "Invalid Xray SHA-256"
    );
    println!("cargo:rustc-env=WAYRILL_XRAY_VERSION={version}");
    println!(
        "cargo:rustc-env=WAYRILL_XRAY_SHA={}",
        hash.to_ascii_lowercase()
    );
    println!("cargo:rerun-if-changed={}", root.join("src").display());
    println!(
        "cargo:rerun-if-changed={}",
        root.join("tools/Build-SubscriptionEngine.mjs").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        root.join("package-lock.json").display()
    );
    let output = PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("subscription-engine.js");
    let status=Command::new("node").arg(root.join("tools/Build-SubscriptionEngine.mjs")).arg(output)
        .current_dir(&root).status().expect("Node.js and the pinned frontend dependencies are required to build the subscription engine");
    assert!(
        status.success(),
        "The subscription engine bundle failed to build"
    );
}
