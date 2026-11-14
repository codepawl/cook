use std::env;
use std::fs;
use std::path::{Component, Path, PathBuf};

fn parse_manifest_entries(manifest_text: &str) -> Vec<String> {
    let mut entries = Vec::new();
    let without_file_bom = manifest_text.trim_start_matches('\u{feff}');
    for raw_line in without_file_bom.lines() {
        let without_line_bom = raw_line.trim_start_matches('\u{feff}');
        let without_comment = without_line_bom.split('#').next().unwrap_or("");
        let trimmed = without_comment.trim();
        if !trimmed.is_empty() {
            entries.push(trimmed.to_string());
        }
    }
    entries
}

fn validate_relative_shader_path(cycles_directory: &Path, relative_entry: &str) -> PathBuf {
    let entry_path = Path::new(relative_entry);
    if entry_path.is_absolute() {
        panic!("Cycles kernel manifest entry must be relative: {relative_entry}");
    }
    for component in entry_path.components() {
        if !matches!(component, Component::Normal(_)) {
            panic!("Cycles kernel manifest entry must stay inside src/cycles: {relative_entry}");
        }
    }
    let resolved = cycles_directory.join(entry_path);
    if !resolved.is_file() {
        panic!("Cycles kernel manifest entry does not exist: src/cycles/{relative_entry}");
    }
    resolved
}

fn rust_byte_array_literal(bytes: &[u8]) -> String {
    let mut text = String::with_capacity(bytes.len() * 4 + 4);
    text.push_str("&[");
    for (index, byte) in bytes.iter().enumerate() {
        if index > 0 {
            text.push(',');
        }
        text.push_str(&byte.to_string());
    }
    text.push(']');
    text
}

fn read_package_version(package_json_text: &str) -> String {
    for line in package_json_text.lines() {
        let Some(after_key) = line.strip_prefix("  \"version\":") else {
            continue;
        };
        let version = after_key.trim().trim_end_matches(',').trim().trim_matches('"');
        if !version.is_empty() {
            return version.to_string();
        }
    }
    panic!("package.json has no top-level \"version\" field");
}

fn read_pack_revision(packer_text: &str) -> String {
    for line in packer_text.lines() {
        let Some(after_name) = line.trim().strip_prefix("export const PACK_REVISION =") else {
            continue;
        };
        let digits = after_name.trim().trim_end_matches(';').trim();
        if !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit()) {
            return digits.to_string();
        }
    }
    panic!("pack-input-v2.mjs has no `export const PACK_REVISION = <number>;` line");
}

/// The addon reports these two values so the JavaScript package can tell when it loaded an addon built from other sources.
fn export_addon_build_info() {
    for tracked in ["package.json", "pack-input-v2.mjs"] {
        println!("cargo:rerun-if-changed={tracked}");
    }
    let package_json_text = fs::read_to_string("package.json")
        .unwrap_or_else(|error| panic!("Could not read package.json: {error}"));
    let packer_text = fs::read_to_string("pack-input-v2.mjs")
        .unwrap_or_else(|error| panic!("Could not read pack-input-v2.mjs: {error}"));
    println!("cargo:rustc-env=COOK_PACKAGE_VERSION={}", read_package_version(&package_json_text));
    println!("cargo:rustc-env=COOK_PACK_REVISION={}", read_pack_revision(&packer_text));
}

fn main() {
    napi_build::setup();
    export_addon_build_info();

    let cycles_directory = PathBuf::from("src").join("cycles");
    let manifest_path = cycles_directory.join("kernel-manifest.txt");
    let bootstrap_path = cycles_directory.join("bootstrap_main.wgsl");
    println!("cargo:rerun-if-changed={}", manifest_path.display());
    println!("cargo:rerun-if-changed={}", bootstrap_path.display());

    let manifest_text = fs::read_to_string(&manifest_path)
        .unwrap_or_else(|error| panic!("Could not read {}: {error}", manifest_path.display()));
    let entries = parse_manifest_entries(&manifest_text);

    let mut generated = String::from("pub(crate) const CYCLES_MANIFEST_FILES: &[(&str, &[u8])] = &[\n");
    for entry in &entries {
        let shader_path = validate_relative_shader_path(&cycles_directory, entry);
        println!("cargo:rerun-if-changed={}", shader_path.display());
        let shader_bytes = fs::read(&shader_path)
            .unwrap_or_else(|error| panic!("Could not read {}: {error}", shader_path.display()));
        generated.push_str(&format!("    ({entry:?}, {}),\n", rust_byte_array_literal(&shader_bytes)));
    }
    generated.push_str("];\n");

    let out_directory = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR must be set by cargo"));
    let generated_path = out_directory.join("cycles_manifest_files.rs");
    fs::write(&generated_path, generated)
        .unwrap_or_else(|error| panic!("Could not write {}: {error}", generated_path.display()));
}
