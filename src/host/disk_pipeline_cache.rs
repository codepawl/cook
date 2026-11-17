//! A Vulkan pipeline cache that survives the process.
//!
//! Compiling a specialized Cycles kernel costs seconds on the driver the first time a scene variant is traced
//! (7 s for a scene without emitters on an RTX 3060, issue #1949). The driver hands its compiled code back through a
//! pipeline cache blob. This module keeps that blob in one file per user, per adapter and per Cook version, so a
//! second process with the same variant skips the compile.
//!
//! The file is not trusted: it carries a length and a checksum that are checked before the blob reaches the driver,
//! it is capped in size, and it is written to a temporary name and renamed so a crash never leaves half a file.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// The largest cache file Cook reads or writes. One specialized kernel adds well under a megabyte on the drivers measured.
pub(crate) const MAX_CACHE_FILE_BYTES: u64 = 64 * 1024 * 1024;

const FILE_MAGIC: [u8; 8] = *b"COOKPLC1";
const HEADER_BYTES: usize = 8 + 8 + 8;

/// What the pipeline cache did when the device opened, reported in every trace result as `pipelineCache`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum PipelineCacheStatus {
    /// Switched off with `COOK_PIPELINE_CACHE=off`, or no per-user directory could be found.
    Off,
    /// The adapter does not offer pipeline caches.
    Unsupported,
    /// Enabled, with no usable file yet: the first trace of each variant compiles and then stores it.
    Cold,
    /// Enabled, and a file from an earlier process was handed to the driver.
    Warm,
}

impl PipelineCacheStatus {
    pub(crate) fn as_report(self) -> &'static str {
        match self {
            PipelineCacheStatus::Off => "off",
            PipelineCacheStatus::Unsupported => "unsupported",
            PipelineCacheStatus::Cold => "cold",
            PipelineCacheStatus::Warm => "warm",
        }
    }
}

/// The environment that decides where the cache file goes.
#[derive(Clone, Debug, Default)]
pub(crate) struct CacheEnvironment {
    /// `COOK_PIPELINE_CACHE`: `off`, `0` or `false` switch the cache off.
    pub(crate) switch: Option<String>,
    /// `COOK_PIPELINE_CACHE_DIR`: use this folder instead of the per-user one.
    pub(crate) directory_override: Option<String>,
    pub(crate) local_app_data: Option<String>,
    pub(crate) xdg_cache_home: Option<String>,
    pub(crate) home: Option<String>,
}

impl CacheEnvironment {
    pub(crate) fn from_process() -> CacheEnvironment {
        let read = |name: &str| std::env::var(name).ok().filter(|value| !value.is_empty());
        CacheEnvironment {
            switch: read("COOK_PIPELINE_CACHE"),
            directory_override: read("COOK_PIPELINE_CACHE_DIR"),
            local_app_data: read("LOCALAPPDATA"),
            xdg_cache_home: read("XDG_CACHE_HOME"),
            home: read("HOME").or_else(|| read("USERPROFILE")),
        }
    }
}

/// The folder for cache files, or `None` when the cache is switched off or no per-user folder exists.
pub(crate) fn resolve_cache_directory(environment: &CacheEnvironment, windows: bool) -> Option<PathBuf> {
    if let Some(switch) = &environment.switch {
        if matches!(switch.to_ascii_lowercase().as_str(), "off" | "0" | "false" | "no") {
            return None;
        }
    }
    if let Some(directory) = &environment.directory_override {
        return Some(PathBuf::from(directory));
    }
    let base = if windows {
        PathBuf::from(environment.local_app_data.as_ref()?).join("codepawl")
    } else if let Some(xdg) = &environment.xdg_cache_home {
        PathBuf::from(xdg)
    } else {
        PathBuf::from(environment.home.as_ref()?).join(".cache")
    };
    Some(base.join("cook").join("pipeline-cache"))
}

/// A file name that holds only letters, digits, dots, dashes and underscores, from the wgpu adapter key and the Cook version.
pub(crate) fn cache_file_name(adapter_key: &str, cook_version: &str) -> String {
    let clean = |text: &str| -> String {
        text.chars().map(|character| if character.is_ascii_alphanumeric() || character == '.' || character == '-' { character } else { '_' }).collect()
    };
    format!("{}_cook{}.bin", clean(adapter_key), clean(cook_version))
}

fn checksum(payload: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in payload {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// The bytes of a cache file for `payload`: magic, payload length, checksum, payload.
pub(crate) fn encode_cache_file(payload: &[u8]) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(HEADER_BYTES + payload.len());
    bytes.extend_from_slice(&FILE_MAGIC);
    bytes.extend_from_slice(&(payload.len() as u64).to_le_bytes());
    bytes.extend_from_slice(&checksum(payload).to_le_bytes());
    bytes.extend_from_slice(payload);
    bytes
}

/// The payload of a cache file, or `None` when the file is too short, has another magic, a wrong length or a wrong checksum.
pub(crate) fn decode_cache_file(bytes: &[u8]) -> Option<&[u8]> {
    if bytes.len() < HEADER_BYTES || bytes[..8] != FILE_MAGIC {
        return None;
    }
    let declared_length = u64::from_le_bytes(bytes[8..16].try_into().ok()?);
    let declared_checksum = u64::from_le_bytes(bytes[16..24].try_into().ok()?);
    let payload = &bytes[HEADER_BYTES..];
    if payload.len() as u64 != declared_length || checksum(payload) != declared_checksum {
        return None;
    }
    Some(payload)
}

/// Reads the payload stored at `path`. A missing file gives `None`. A file that is over the size cap, damaged or
/// unreadable is deleted and gives `None`, so the next run starts a fresh cache instead of failing again.
pub(crate) fn read_cache_payload(path: &Path) -> Option<Vec<u8>> {
    let size = fs::metadata(path).ok()?.len();
    if size > MAX_CACHE_FILE_BYTES + HEADER_BYTES as u64 {
        let _ = fs::remove_file(path);
        return None;
    }
    let bytes = fs::read(path).ok()?;
    match decode_cache_file(&bytes) {
        Some(payload) => Some(payload.to_vec()),
        None => {
            let _ = fs::remove_file(path);
            None
        }
    }
}

/// Why a cache file was not written.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum WriteOutcome {
    Written,
    /// The payload is over `MAX_CACHE_FILE_BYTES`: the file on disk stays as it is.
    TooLarge,
    Failed,
}

/// Writes `payload` to `path` through a temporary file in the same folder and a rename, so a reader never sees half a file.
pub(crate) fn write_cache_payload(path: &Path, payload: &[u8]) -> WriteOutcome {
    if payload.len() as u64 > MAX_CACHE_FILE_BYTES {
        return WriteOutcome::TooLarge;
    }
    let Some(directory) = path.parent() else {
        return WriteOutcome::Failed;
    };
    if fs::create_dir_all(directory).is_err() {
        return WriteOutcome::Failed;
    }
    let temporary_path = path.with_extension(format!("{}.tmp", std::process::id()));
    let written = fs::File::create(&temporary_path).and_then(|mut file| {
        file.write_all(&encode_cache_file(payload))?;
        file.sync_all()
    });
    if written.is_err() || fs::rename(&temporary_path, path).is_err() {
        let _ = fs::remove_file(&temporary_path);
        return WriteOutcome::Failed;
    }
    WriteOutcome::Written
}

/// The driver's pipeline cache for the cached device, and the file it is stored in.
pub(crate) struct DiskPipelineCache {
    pub(crate) cache: wgpu::PipelineCache,
    path: PathBuf,
    pub(crate) status: PipelineCacheStatus,
    /// The size of the blob last written, so a compile that adds nothing does not rewrite the file.
    last_stored_bytes: Mutex<usize>,
}

impl DiskPipelineCache {
    /// Opens the cache for `adapter_info`, or returns the reason there is none.
    pub(crate) fn open(
        device: &wgpu::Device,
        adapter_info: &wgpu::AdapterInfo,
        environment: &CacheEnvironment,
    ) -> Result<DiskPipelineCache, PipelineCacheStatus> {
        if !device.features().contains(wgpu::Features::PIPELINE_CACHE) {
            return Err(PipelineCacheStatus::Unsupported);
        }
        let adapter_key = wgpu::util::pipeline_cache_key(adapter_info).ok_or(PipelineCacheStatus::Unsupported)?;
        let directory = resolve_cache_directory(environment, cfg!(windows)).ok_or(PipelineCacheStatus::Off)?;
        let path = directory.join(cache_file_name(&adapter_key, env!("COOK_PACKAGE_VERSION")));
        let stored = read_cache_payload(&path);
        let status = if stored.is_some() { PipelineCacheStatus::Warm } else { PipelineCacheStatus::Cold };
        // SAFETY: the blob passed the length and checksum check above and wgpu rejects data from another driver
        // (`fallback: true` starts an empty cache instead of failing).
        let cache = unsafe {
            device.create_pipeline_cache(&wgpu::PipelineCacheDescriptor {
                label: Some("cook pipeline cache"),
                data: stored.as_deref(),
                fallback: true,
            })
        };
        let last_stored_bytes = stored.as_ref().map_or(0, Vec::len);
        Ok(DiskPipelineCache { cache, path, status, last_stored_bytes: Mutex::new(last_stored_bytes) })
    }

    /// Writes the cache to its file after a compile added to it. Best effort: a failure costs only the next process a compile.
    pub(crate) fn store(&self) {
        let Some(blob) = self.cache.get_data() else {
            return;
        };
        let Ok(mut last_stored_bytes) = self.last_stored_bytes.lock() else {
            return;
        };
        if blob.len() == *last_stored_bytes {
            return;
        }
        match write_cache_payload(&self.path, &blob) {
            WriteOutcome::Written => *last_stored_bytes = blob.len(),
            // A cache that grew past the cap is not kept: the next process starts a fresh one instead of loading a stale file for ever.
            WriteOutcome::TooLarge => {
                let _ = fs::remove_file(&self.path);
            }
            WriteOutcome::Failed => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_directory(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!("cook-pipeline-cache-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        directory
    }

    #[test]
    fn a_file_round_trips_and_a_flipped_byte_is_refused() {
        let payload: Vec<u8> = (0..=255).collect();
        let mut bytes = encode_cache_file(&payload);
        assert_eq!(decode_cache_file(&bytes), Some(payload.as_slice()));
        let last = bytes.len() - 1;
        bytes[last] ^= 1;
        assert_eq!(decode_cache_file(&bytes), None);
    }

    #[test]
    fn a_truncated_or_foreign_file_is_refused() {
        let bytes = encode_cache_file(&[1, 2, 3, 4]);
        assert_eq!(decode_cache_file(&bytes[..bytes.len() - 1]), None);
        assert_eq!(decode_cache_file(&bytes[..10]), None);
        assert_eq!(decode_cache_file(b"not a cook cache file at all"), None);
        assert_eq!(decode_cache_file(&[]), None);
    }

    #[test]
    fn the_directory_follows_the_switch_the_override_and_the_platform() {
        let mut environment = CacheEnvironment {
            local_app_data: Some("C:/Users/a/AppData/Local".into()),
            home: Some("/home/a".into()),
            ..CacheEnvironment::default()
        };
        assert_eq!(
            resolve_cache_directory(&environment, true),
            Some(PathBuf::from("C:/Users/a/AppData/Local").join("codepawl").join("cook").join("pipeline-cache"))
        );
        assert_eq!(
            resolve_cache_directory(&environment, false),
            Some(PathBuf::from("/home/a").join(".cache").join("cook").join("pipeline-cache"))
        );
        environment.xdg_cache_home = Some("/var/xdg".into());
        assert_eq!(resolve_cache_directory(&environment, false), Some(PathBuf::from("/var/xdg").join("cook").join("pipeline-cache")));
        environment.directory_override = Some("/tmp/own".into());
        assert_eq!(resolve_cache_directory(&environment, false), Some(PathBuf::from("/tmp/own")));
        environment.switch = Some("Off".into());
        assert_eq!(resolve_cache_directory(&environment, false), None);
        assert_eq!(resolve_cache_directory(&CacheEnvironment::default(), false), None);
    }

    #[test]
    fn the_file_name_is_safe_and_names_the_adapter_and_the_version() {
        let name = cache_file_name("wgpu_pipeline_cache_vulkan_4318_9999", "0.1.0/../x");
        assert_eq!(name, "wgpu_pipeline_cache_vulkan_4318_9999_cook0.1.0_.._x.bin");
        assert!(!name.contains('/'));
    }

    #[test]
    fn a_written_cache_reads_back_and_leaves_no_temporary_file() {
        let directory = scratch_directory("roundtrip");
        let path = directory.join("nested").join("cache.bin");
        assert_eq!(write_cache_payload(&path, &[9, 8, 7]), WriteOutcome::Written);
        assert_eq!(read_cache_payload(&path), Some(vec![9, 8, 7]));
        let leftovers = fs::read_dir(path.parent().unwrap()).unwrap().count();
        assert_eq!(leftovers, 1);
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn a_corrupt_file_is_deleted_and_reads_as_missing() {
        let directory = scratch_directory("corrupt");
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("cache.bin");
        fs::write(&path, b"garbage").unwrap();
        assert_eq!(read_cache_payload(&path), None);
        assert!(!path.exists(), "a damaged file must not stay to fail again");
        assert_eq!(read_cache_payload(&path), None);
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn an_oversized_payload_is_not_written_and_an_oversized_file_is_dropped() {
        let directory = scratch_directory("large");
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("cache.bin");
        let too_large = vec![0u8; MAX_CACHE_FILE_BYTES as usize + 1];
        assert_eq!(write_cache_payload(&path, &too_large), WriteOutcome::TooLarge);
        assert!(!path.exists());
        fs::write(&path, vec![1u8; MAX_CACHE_FILE_BYTES as usize + HEADER_BYTES + 1]).unwrap();
        assert_eq!(read_cache_payload(&path), None);
        assert!(!path.exists());
        let _ = fs::remove_dir_all(&directory);
    }
}
