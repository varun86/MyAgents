use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{ErrorKind, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{ChildStderr, ChildStdout, Stdio};
use std::thread;
use std::time::Duration;

use base64::{engine::general_purpose, Engine as _};
use chrono::Utc;
use minisign_verify::{Error as MinisignError, PublicKey, Signature};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use zip::ZipArchive;

use crate::utils::file_lock::{with_file_lock_blocking, FileLockError, FileLockOptions};
use crate::{ulog_error, ulog_info, ulog_warn};

const CODEX_PROVIDER_ID: &str = "codex-sub";
const REQUIRED_VERSION: &str = "0.142.2";
const REQUIRED_APP_RUNTIME_SET: &str = "0.2.43";
const MANIFEST_URL: &str =
    "https://download.myagents.io/runtimes/codex/by-app/0.2.43/manifest-v1.json";
// Keep this in sync with `src-tauri/tauri.conf.json > plugins.updater.pubkey`.
// Managed runtime artifacts use the same minisign trust root as app updates.
const MYAGENTS_MINISIGN_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IEY3RkQ5QjIzMTE4RTgyRTkKUldUcGdvNFJJNXY5OTB3T2pnUzVUbjFrV203Zk5ZTDg0NVJRdGI0UVRranJzTUsvM0hGcmFlc0IK";
const MANIFEST_SCHEMA_VERSION: u32 = 1;
const DOWNLOAD_HOST: &str = "download.myagents.io";
const DOWNLOAD_PATH_PREFIX: &str = "/runtimes/codex/";
const MAX_MANIFEST_BYTES: u64 = 256 * 1024;
const MAX_ARCHIVE_BYTES: u64 = 512 * 1024 * 1024;
const MAX_UNPACKED_BYTES: u64 = 900 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 4096;
const MAX_CAPTURED_OUTPUT_CHARS: usize = 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedCodexRuntimeInstallState {
    pub status: String,
    pub required_version: Option<String>,
    pub installed_version: Option<String>,
    pub platform: Option<String>,
    pub installed_at: Option<String>,
    pub last_checked_at: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedCodexAuthState {
    pub status: String,
    pub auth_method: Option<String>,
    pub account_email: Option<String>,
    pub verified_at: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedCodexStatus {
    pub runtime_install: ManagedCodexRuntimeInstallState,
    pub auth: ManagedCodexAuthState,
    pub codex_home: Option<String>,
    pub runtime_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstalledJson {
    version: String,
    platform: String,
    sha256: Option<String>,
    installed_at: Option<String>,
    source_url: Option<String>,
    executable_relative_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedCodexManifest {
    schema_version: u32,
    app_version: String,
    codex_version: String,
    artifacts: HashMap<String, ManagedCodexArtifact>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManagedCodexArtifact {
    url: String,
    sha256: String,
    signature: String,
    executable_relative_path: String,
    #[serde(default = "default_archive_type")]
    archive_type: String,
    #[serde(default)]
    archive_size_bytes: Option<u64>,
    #[serde(default)]
    unpacked_size_bytes: Option<u64>,
    #[serde(default)]
    entry_count: Option<u64>,
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

fn default_archive_type() -> String {
    "zip".to_string()
}

fn platform_key() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => Some("darwin-arm64"),
        ("macos", "x86_64") => Some("darwin-x64"),
        ("windows", "x86_64") => Some("win32-x64"),
        _ => None,
    }
}

fn data_dir() -> Result<PathBuf, String> {
    crate::app_dirs::myagents_data_dir()
        .ok_or_else(|| "[managed-codex] Cannot determine ~/.myagents directory".to_string())
}

fn codex_home() -> Result<PathBuf, String> {
    Ok(data_dir()?.join("codex"))
}

fn runtime_root() -> Result<PathBuf, String> {
    Ok(data_dir()?.join("runtimes").join("codex"))
}

fn installed_json_path() -> Result<PathBuf, String> {
    Ok(runtime_root()?.join("installed.json"))
}

fn required_install_dir(platform: &str) -> Result<PathBuf, String> {
    Ok(runtime_root()?.join(REQUIRED_VERSION).join(platform))
}

fn normalize_out_path(path: PathBuf) -> String {
    crate::sidecar::normalize_external_path(path)
        .to_string_lossy()
        .to_string()
}

fn read_installed_json() -> Option<InstalledJson> {
    let path = installed_json_path().ok()?;
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

fn managed_codex_binary_path(platform: &str) -> Option<PathBuf> {
    let dir = required_install_dir(platform).ok()?;
    if let Some(meta) = read_installed_json() {
        if meta.version == REQUIRED_VERSION && meta.platform == platform {
            if let Some(rel) = meta.executable_relative_path.as_deref() {
                if let Ok(rel_path) = validate_executable_relative_path(rel) {
                    let candidate = dir.join(rel_path);
                    if candidate.is_file() {
                        return Some(candidate);
                    }
                }
            }
        }
    }
    let candidates: Vec<PathBuf> = if cfg!(windows) {
        vec![
            dir.join("codex.exe"),
            dir.join("codex.cmd"),
            dir.join("bin").join("codex.exe"),
            dir.join("bin").join("codex.cmd"),
        ]
    } else {
        vec![dir.join("codex"), dir.join("bin").join("codex")]
    };
    candidates.into_iter().find(|p| p.is_file())
}

fn normalize_sha256_hex(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.len() != 64 || !trimmed.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(format!(
            "Invalid SHA-256 value in Managed Codex manifest: {}",
            trimmed.chars().take(16).collect::<String>()
        ));
    }
    Ok(trimmed.to_ascii_lowercase())
}

fn is_windows_reserved_segment(segment: &str) -> bool {
    let trimmed = segment.trim_end_matches([' ', '.']);
    if trimmed != segment {
        return true;
    }
    let stem = trimmed
        .split('.')
        .next()
        .unwrap_or(trimmed)
        .to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

fn validate_relative_archive_path(raw: &str) -> Result<PathBuf, String> {
    if raw.is_empty() {
        return Err("Archive entry path is empty".to_string());
    }
    if raw.contains('\\') || raw.contains('\0') || raw.contains("//") {
        return Err(format!(
            "Archive entry contains an unsafe separator: {}",
            raw
        ));
    }

    let mut out = PathBuf::new();
    let mut count = 0usize;
    for component in Path::new(raw).components() {
        match component {
            Component::Normal(segment) => {
                let segment = segment
                    .to_str()
                    .ok_or_else(|| format!("Archive entry is not valid UTF-8: {}", raw))?;
                if segment.is_empty()
                    || segment == "."
                    || segment == ".."
                    || segment.contains(':')
                    || is_windows_reserved_segment(segment)
                {
                    return Err(format!("Archive entry contains unsafe segment: {}", raw));
                }
                count += 1;
                if count > 64 || segment.len() > 255 {
                    return Err(format!(
                        "Archive entry path is too deep or too long: {}",
                        raw
                    ));
                }
                out.push(segment);
            }
            _ => {
                return Err(format!(
                    "Archive entry must be a relative normalized path: {}",
                    raw
                ));
            }
        }
    }
    if out.as_os_str().is_empty() {
        return Err("Archive entry path is empty".to_string());
    }
    Ok(out)
}

fn validate_executable_relative_path(raw: &str) -> Result<PathBuf, String> {
    if raw.ends_with('/') {
        return Err("Managed Codex executable path must point to a file".to_string());
    }
    let path = validate_relative_archive_path(raw)?;
    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "Managed Codex executable path has no file name".to_string())?;
    if !matches!(file_name, "codex" | "codex.exe" | "codex.cmd") {
        return Err(format!(
            "Managed Codex executable must be codex/codex.exe/codex.cmd, got {}",
            raw
        ));
    }
    Ok(path)
}

fn validate_download_url(raw: &str) -> Result<(), String> {
    let parsed =
        reqwest::Url::parse(raw).map_err(|e| format!("Invalid Managed Codex URL: {}", e))?;
    if parsed.scheme() != "https" {
        return Err(format!("Managed Codex URL must use HTTPS: {}", raw));
    }
    if parsed.host_str() != Some(DOWNLOAD_HOST) {
        return Err(format!(
            "Managed Codex URL must be hosted on {}: {}",
            DOWNLOAD_HOST, raw
        ));
    }
    if !parsed.path().starts_with(DOWNLOAD_PATH_PREFIX) {
        return Err(format!(
            "Managed Codex URL must stay under {}: {}",
            DOWNLOAD_PATH_PREFIX, raw
        ));
    }
    if parsed.username() != "" || parsed.password().is_some() || parsed.fragment().is_some() {
        return Err(format!(
            "Managed Codex URL contains unsupported auth/fragment: {}",
            raw
        ));
    }
    Ok(())
}

fn validate_manifest_for_platform(
    manifest: ManagedCodexManifest,
    platform: &str,
) -> Result<ManagedCodexArtifact, String> {
    if manifest.schema_version != MANIFEST_SCHEMA_VERSION {
        return Err(format!(
            "Unsupported Managed Codex manifest schema: {}",
            manifest.schema_version
        ));
    }
    if manifest.app_version != REQUIRED_APP_RUNTIME_SET {
        return Err(format!(
            "Managed Codex manifest appVersion mismatch: expected {}, got {}",
            REQUIRED_APP_RUNTIME_SET, manifest.app_version
        ));
    }
    if manifest.codex_version != REQUIRED_VERSION {
        return Err(format!(
            "Managed Codex manifest codexVersion mismatch: expected {}, got {}",
            REQUIRED_VERSION, manifest.codex_version
        ));
    }
    let artifact = manifest
        .artifacts
        .get(platform)
        .cloned()
        .ok_or_else(|| format!("Managed Codex manifest has no artifact for {}", platform))?;
    if artifact.archive_type != "zip" {
        return Err(format!(
            "Unsupported Managed Codex archive type for {}: {}",
            platform, artifact.archive_type
        ));
    }
    validate_download_url(&artifact.url)?;
    normalize_sha256_hex(&artifact.sha256)?;
    validate_executable_relative_path(&artifact.executable_relative_path)?;
    if artifact.signature.trim().is_empty() {
        return Err("Managed Codex artifact signature is required".to_string());
    }
    if let Some(size) = artifact.archive_size_bytes {
        if size == 0 || size > MAX_ARCHIVE_BYTES {
            return Err(format!(
                "Managed Codex artifact size is outside allowed bounds: {} bytes",
                size
            ));
        }
    }
    if let Some(size) = artifact.unpacked_size_bytes {
        if size == 0 || size > MAX_UNPACKED_BYTES {
            return Err(format!(
                "Managed Codex unpacked size is outside allowed bounds: {} bytes",
                size
            ));
        }
    }
    if let Some(entries) = artifact.entry_count {
        if entries == 0 || entries as usize > MAX_ARCHIVE_ENTRIES {
            return Err(format!(
                "Managed Codex archive entry count is outside allowed bounds: {}",
                entries
            ));
        }
    }
    Ok(artifact)
}

#[allow(clippy::disallowed_methods)]
fn external_http_client(timeout: Duration) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(timeout)
        .connect_timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("[managed-codex] Failed to build HTTP client: {}", e))
}

fn fetch_limited_bytes(
    client: &reqwest::blocking::Client,
    url: &str,
    max_bytes: u64,
    label: &str,
) -> Result<Vec<u8>, String> {
    validate_download_url(url)?;
    let mut response = client
        .get(url)
        .send()
        .map_err(|e| format!("[managed-codex] Failed to fetch {}: {}", label, e))?
        .error_for_status()
        .map_err(|e| format!("[managed-codex] Failed to fetch {}: {}", label, e))?;
    if response.content_length().unwrap_or(0) > max_bytes {
        return Err(format!(
            "[managed-codex] {} exceeds max size: {} bytes",
            label,
            response.content_length().unwrap_or(0)
        ));
    }
    let mut out = Vec::new();
    let mut total = 0u64;
    let mut buf = [0u8; 16 * 1024];
    loop {
        let read = response
            .read(&mut buf)
            .map_err(|e| format!("[managed-codex] Failed to read {}: {}", label, e))?;
        if read == 0 {
            break;
        }
        total += read as u64;
        if total > max_bytes {
            return Err(format!("[managed-codex] {} exceeded max size", label));
        }
        out.extend_from_slice(&buf[..read]);
    }
    Ok(out)
}

fn download_to_file_with_hash(
    client: &reqwest::blocking::Client,
    url: &str,
    path: &Path,
    max_bytes: u64,
) -> Result<(u64, String), String> {
    validate_download_url(url)?;
    let mut response = client
        .get(url)
        .send()
        .map_err(|e| format!("[managed-codex] Failed to download artifact: {}", e))?
        .error_for_status()
        .map_err(|e| format!("[managed-codex] Failed to download artifact: {}", e))?;
    if response.content_length().unwrap_or(0) > max_bytes {
        return Err(format!(
            "[managed-codex] Artifact exceeds max size: {} bytes",
            response.content_length().unwrap_or(0)
        ));
    }
    let mut file = File::create(path)
        .map_err(|e| format!("[managed-codex] Failed to create artifact file: {}", e))?;
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut buf = [0u8; 64 * 1024];
    loop {
        let read = response
            .read(&mut buf)
            .map_err(|e| format!("[managed-codex] Failed to read artifact: {}", e))?;
        if read == 0 {
            break;
        }
        total += read as u64;
        if total > max_bytes {
            return Err("[managed-codex] Artifact exceeded max size".to_string());
        }
        hasher.update(&buf[..read]);
        file.write_all(&buf[..read])
            .map_err(|e| format!("[managed-codex] Failed to write artifact: {}", e))?;
    }
    Ok((total, format!("{:x}", hasher.finalize())))
}

fn base64_to_string(value: &str, label: &str) -> Result<String, String> {
    let bytes = general_purpose::STANDARD
        .decode(value)
        .map_err(|e| format!("[managed-codex] Invalid {} base64: {}", label, e))?;
    String::from_utf8(bytes).map_err(|e| format!("[managed-codex] Invalid {} UTF-8: {}", label, e))
}

fn managed_minisign_public_key() -> Result<PublicKey, String> {
    let decoded = base64_to_string(MYAGENTS_MINISIGN_PUBKEY, "public key")?;
    PublicKey::decode(&decoded)
        .map_err(|e| format!("[managed-codex] Invalid minisign public key: {}", e))
}

fn managed_minisign_signature(signature: &str) -> Result<Signature, String> {
    let decoded = base64_to_string(signature, "artifact signature")?;
    Signature::decode(&decoded)
        .map_err(|e| format!("[managed-codex] Invalid artifact signature: {}", e))
}

fn verify_minisign_file(path: &Path, signature: &str) -> Result<(), String> {
    let public_key = managed_minisign_public_key()?;
    let signature = managed_minisign_signature(signature)?;
    match public_key.verify_stream(&signature) {
        Ok(mut verifier) => {
            let mut file = File::open(path)
                .map_err(|e| format!("[managed-codex] Failed to open artifact: {}", e))?;
            let mut buf = [0u8; 64 * 1024];
            loop {
                let read = file
                    .read(&mut buf)
                    .map_err(|e| format!("[managed-codex] Failed to read artifact: {}", e))?;
                if read == 0 {
                    break;
                }
                verifier.update(&buf[..read]);
            }
            verifier
                .finalize()
                .map_err(|e| format!("[managed-codex] Artifact signature mismatch: {}", e))
        }
        Err(MinisignError::UnsupportedLegacyMode) => {
            let bytes = fs::read(path)
                .map_err(|e| format!("[managed-codex] Failed to read artifact: {}", e))?;
            public_key
                .verify(&bytes, &signature, true)
                .map_err(|e| format!("[managed-codex] Artifact signature mismatch: {}", e))
        }
        Err(e) => Err(format!(
            "[managed-codex] Cannot initialize artifact signature verifier: {}",
            e
        )),
    }
}

fn zip_entry_is_symlink(mode: Option<u32>) -> bool {
    mode.map(|m| (m & 0o170000) == 0o120000).unwrap_or(false)
}

fn extract_managed_codex_zip(
    archive_path: &Path,
    destination: &Path,
    artifact: &ManagedCodexArtifact,
) -> Result<PathBuf, String> {
    let archive_file = File::open(archive_path)
        .map_err(|e| format!("[managed-codex] Failed to open artifact zip: {}", e))?;
    let mut zip = ZipArchive::new(archive_file)
        .map_err(|e| format!("[managed-codex] Failed to read artifact zip: {}", e))?;
    if zip.is_empty() || zip.len() > MAX_ARCHIVE_ENTRIES {
        return Err(format!(
            "[managed-codex] Artifact zip entry count is outside allowed bounds: {}",
            zip.len()
        ));
    }
    if let Some(expected) = artifact.entry_count {
        if expected as usize != zip.len() {
            return Err(format!(
                "[managed-codex] Artifact entry count mismatch: expected {}, got {}",
                expected,
                zip.len()
            ));
        }
    }

    fs::create_dir_all(destination)
        .map_err(|e| format!("[managed-codex] Failed to create staging dir: {}", e))?;
    let mut unpacked_bytes = 0u64;
    for index in 0..zip.len() {
        let mut file = zip
            .by_index(index)
            .map_err(|e| format!("[managed-codex] Failed to read zip entry: {}", e))?;
        let raw_name = file.name().to_string();
        let rel_path = validate_relative_archive_path(raw_name.trim_end_matches('/'))?;
        if zip_entry_is_symlink(file.unix_mode()) {
            return Err(format!(
                "[managed-codex] Symlinks are not allowed in runtime artifact: {}",
                raw_name
            ));
        }
        unpacked_bytes = unpacked_bytes
            .checked_add(file.size())
            .ok_or_else(|| "[managed-codex] Artifact unpacked size overflow".to_string())?;
        if unpacked_bytes > MAX_UNPACKED_BYTES {
            return Err("[managed-codex] Artifact unpacked size exceeded limit".to_string());
        }

        let out_path = destination.join(rel_path);
        if file.is_dir() || raw_name.ends_with('/') {
            fs::create_dir_all(&out_path)
                .map_err(|e| format!("[managed-codex] Failed to create directory: {}", e))?;
            continue;
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("[managed-codex] Failed to create parent dir: {}", e))?;
        }
        let mut out_file = File::create(&out_path)
            .map_err(|e| format!("[managed-codex] Failed to create extracted file: {}", e))?;
        let copied = std::io::copy(&mut file, &mut out_file)
            .map_err(|e| format!("[managed-codex] Failed to extract zip entry: {}", e))?;
        if copied != file.size() {
            return Err(format!(
                "[managed-codex] Zip entry size mismatch for {}: expected {}, got {}",
                raw_name,
                file.size(),
                copied
            ));
        }
        #[cfg(unix)]
        if let Some(mode) = file.unix_mode() {
            use std::os::unix::fs::PermissionsExt;
            let safe_mode = mode & 0o777;
            if safe_mode != 0 {
                fs::set_permissions(&out_path, fs::Permissions::from_mode(safe_mode)).map_err(
                    |e| format!("[managed-codex] Failed to set file permissions: {}", e),
                )?;
            }
        }
    }
    if let Some(expected) = artifact.unpacked_size_bytes {
        if expected != unpacked_bytes {
            return Err(format!(
                "[managed-codex] Artifact unpacked size mismatch: expected {}, got {}",
                expected, unpacked_bytes
            ));
        }
    }

    let executable_rel = validate_executable_relative_path(&artifact.executable_relative_path)?;
    let executable = destination.join(&executable_rel);
    if !executable.is_file() {
        return Err(format!(
            "[managed-codex] Artifact did not install declared executable: {}",
            artifact.executable_relative_path
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).map_err(|e| {
            format!(
                "[managed-codex] Failed to mark Codex executable as executable: {}",
                e
            )
        })?;
    }
    Ok(executable_rel)
}

fn write_installed_json(meta: &InstalledJson) -> Result<(), String> {
    let path = installed_json_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("[managed-codex] Failed to create runtime root: {}", e))?;
    }
    let bytes = serde_json::to_vec_pretty(meta).map_err(|e| {
        format!(
            "[managed-codex] Failed to serialize install metadata: {}",
            e
        )
    })?;
    let tmp = path.with_extension(format!("json.tmp-{}", uuid::Uuid::new_v4()));
    fs::write(&tmp, bytes)
        .map_err(|e| format!("[managed-codex] Failed to write install metadata: {}", e))?;
    fs::rename(&tmp, &path)
        .map_err(|e| format!("[managed-codex] Failed to publish install metadata: {}", e))?;
    Ok(())
}

fn has_path_entry(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(false),
        Err(err) => Err(format!(
            "[managed-codex] Failed to inspect path {}: {}",
            path.display(),
            err
        )),
    }
}

fn remove_path_entry(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(meta) => {
            if meta.is_dir() && !meta.file_type().is_symlink() {
                fs::remove_dir_all(path).map_err(|e| {
                    format!(
                        "[managed-codex] Failed to remove directory {}: {}",
                        path.display(),
                        e
                    )
                })
            } else {
                fs::remove_file(path).map_err(|e| {
                    format!(
                        "[managed-codex] Failed to remove file {}: {}",
                        path.display(),
                        e
                    )
                })
            }
        }
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!(
            "[managed-codex] Failed to inspect path {}: {}",
            path.display(),
            err
        )),
    }
}

fn install_verified_artifact(
    platform: &str,
    artifact: &ManagedCodexArtifact,
    archive_path: &Path,
    sha256: &str,
) -> Result<(), String> {
    let root = runtime_root()?;
    fs::create_dir_all(&root)
        .map_err(|e| format!("[managed-codex] Failed to create runtime root: {}", e))?;
    let target = required_install_dir(platform)?;
    let staging = root.join(format!(
        ".staging-{}-{}-{}",
        REQUIRED_VERSION,
        platform,
        uuid::Uuid::new_v4()
    ));
    let backup = root.join(format!(
        ".backup-{}-{}-{}",
        REQUIRED_VERSION,
        platform,
        uuid::Uuid::new_v4()
    ));
    let executable_rel = match extract_managed_codex_zip(archive_path, &staging, artifact) {
        Ok(rel) => rel,
        Err(err) => {
            let _ = fs::remove_dir_all(&staging);
            return Err(err);
        }
    };

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("[managed-codex] Failed to create install parent: {}", e))?;
    }
    if has_path_entry(&target)? {
        fs::rename(&target, &backup)
            .map_err(|e| format!("[managed-codex] Failed to stage existing runtime: {}", e))?;
    }
    if let Err(e) = fs::rename(&staging, &target) {
        if has_path_entry(&backup).unwrap_or(false) {
            let _ = fs::rename(&backup, &target);
        }
        let _ = fs::remove_dir_all(&staging);
        return Err(format!(
            "[managed-codex] Failed to publish managed runtime: {}",
            e
        ));
    }
    let _ = remove_path_entry(&backup);

    write_installed_json(&InstalledJson {
        version: REQUIRED_VERSION.to_string(),
        platform: platform.to_string(),
        sha256: Some(sha256.to_string()),
        installed_at: Some(now_iso()),
        source_url: Some(artifact.url.clone()),
        executable_relative_path: Some(executable_rel.to_string_lossy().to_string()),
    })
}

fn with_runtime_install_lock<F, T>(f: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String>,
{
    let lock_path = runtime_root()?.join("install.lock");
    let options = FileLockOptions {
        timeout: Duration::from_secs(30),
        stale: Duration::from_secs(30 * 60),
        poll: Duration::from_millis(100),
    };
    with_file_lock_blocking(&lock_path, options, || {
        f().map_err(|e| FileLockError::Io(std::io::Error::other(e)))
    })
    .map_err(String::from)
}

fn runtime_install_state() -> ManagedCodexRuntimeInstallState {
    let checked_at = Some(now_iso());
    let Some(platform) = platform_key() else {
        return ManagedCodexRuntimeInstallState {
            status: "error".to_string(),
            required_version: Some(REQUIRED_VERSION.to_string()),
            installed_version: None,
            platform: None,
            installed_at: None,
            last_checked_at: checked_at,
            error: Some(format!(
                "Managed Codex does not support {}-{}",
                std::env::consts::OS,
                std::env::consts::ARCH
            )),
        };
    };

    let installed = read_installed_json();
    let binary = managed_codex_binary_path(platform);
    match (installed, binary) {
        (Some(meta), Some(_)) if meta.version == REQUIRED_VERSION && meta.platform == platform => {
            ManagedCodexRuntimeInstallState {
                status: "installed".to_string(),
                required_version: Some(REQUIRED_VERSION.to_string()),
                installed_version: Some(meta.version),
                platform: Some(platform.to_string()),
                installed_at: meta.installed_at,
                last_checked_at: checked_at,
                error: None,
            }
        }
        (Some(meta), Some(_)) => ManagedCodexRuntimeInstallState {
            status: "update-required".to_string(),
            required_version: Some(REQUIRED_VERSION.to_string()),
            installed_version: Some(meta.version),
            platform: Some(platform.to_string()),
            installed_at: meta.installed_at,
            last_checked_at: checked_at,
            error: None,
        },
        (Some(meta), None) => ManagedCodexRuntimeInstallState {
            status: "error".to_string(),
            required_version: Some(REQUIRED_VERSION.to_string()),
            installed_version: Some(meta.version),
            platform: Some(platform.to_string()),
            installed_at: meta.installed_at,
            last_checked_at: checked_at,
            error: Some(
                "Installed metadata exists, but the managed Codex binary is missing".to_string(),
            ),
        },
        (None, _) => ManagedCodexRuntimeInstallState {
            status: "not-installed".to_string(),
            required_version: Some(REQUIRED_VERSION.to_string()),
            installed_version: None,
            platform: Some(platform.to_string()),
            installed_at: None,
            last_checked_at: checked_at,
            error: None,
        },
    }
}

fn managed_env() -> Result<HashMap<String, String>, String> {
    let home = codex_home()?;
    fs::create_dir_all(&home)
        .map_err(|e| format!("[managed-codex] Cannot create CODEX_HOME: {}", e))?;
    fs::create_dir_all(home.join("logs"))
        .map_err(|e| format!("[managed-codex] Cannot create CODEX_HOME/logs: {}", e))?;
    fs::create_dir_all(home.join("sessions"))
        .map_err(|e| format!("[managed-codex] Cannot create CODEX_HOME/sessions: {}", e))?;

    let allow = [
        "PATH",
        "Path",
        "HOME",
        "USERPROFILE",
        "USER",
        "USERNAME",
        "TMPDIR",
        "TEMP",
        "TMP",
        "SystemRoot",
        "WINDIR",
        "ComSpec",
        "PATHEXT",
        "APPDATA",
        "LOCALAPPDATA",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "NODE_EXTRA_CA_CERTS",
        "MYAGENTS_PROXY_INJECTED",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
    ];
    let mut env = HashMap::new();
    for key in allow {
        if let Ok(value) = std::env::var(key) {
            env.insert(key.to_string(), value);
        }
    }
    env.insert("CODEX_HOME".to_string(), normalize_out_path(home));
    env.insert(
        "MYAGENTS_RUNTIME_SOURCE".to_string(),
        "managed-provider".to_string(),
    );
    Ok(env)
}

fn managed_auth_file() -> Result<PathBuf, String> {
    Ok(codex_home()?.join("auth.json"))
}

fn harden_managed_auth_file_permissions() {
    let Ok(auth_file) = managed_auth_file() else {
        return;
    };
    if !auth_file.is_file() {
        return;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(err) = fs::set_permissions(&auth_file, fs::Permissions::from_mode(0o600)) {
            ulog_warn!(
                "[managed-codex] failed to harden auth file permissions path={} error={}",
                auth_file.display(),
                err
            );
        }
    }
}

fn read_child_stdout(mut stdout: ChildStdout) -> thread::JoinHandle<String> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout.read_to_end(&mut bytes);
        String::from_utf8_lossy(&bytes).trim().to_string()
    })
}

fn read_child_stderr(mut stderr: ChildStderr) -> thread::JoinHandle<String> {
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stderr.read_to_end(&mut bytes);
        String::from_utf8_lossy(&bytes).trim().to_string()
    })
}

fn join_child_output(handle: Option<thread::JoinHandle<String>>) -> String {
    handle.and_then(|h| h.join().ok()).unwrap_or_default()
}

fn run_codex_capture(args: &[&str], timeout: Duration) -> Result<(bool, String, String), String> {
    let platform = platform_key().ok_or_else(|| {
        format!(
            "Managed Codex does not support {}-{}",
            std::env::consts::OS,
            std::env::consts::ARCH
        )
    })?;
    let binary = managed_codex_binary_path(platform).ok_or_else(|| {
        format!(
            "Managed Codex runtime {} is not installed",
            REQUIRED_VERSION
        )
    })?;
    let mut cmd = crate::process_cmd::new(binary);
    cmd.env_clear();
    for (key, value) in managed_env()? {
        cmd.env(key, value);
    }
    cmd.args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    crate::proxy_config::apply_to_subprocess(&mut cmd);

    let start = std::time::Instant::now();
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("[managed-codex] Failed to spawn codex: {}", e))?;
    let mut stdout_handle = child.stdout.take().map(read_child_stdout);
    let mut stderr_handle = child.stderr.take().map(read_child_stderr);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                child
                    .wait()
                    .map_err(|e| format!("[managed-codex] Failed to wait for codex: {}", e))?;
                let stdout = join_child_output(stdout_handle.take());
                let stderr = join_child_output(stderr_handle.take());
                return Ok((status.success(), stdout, stderr));
            }
            Ok(None) if start.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = join_child_output(stdout_handle.take());
                let _ = join_child_output(stderr_handle.take());
                return Err("[managed-codex] Codex command timed out".to_string());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(format!("[managed-codex] Failed to poll codex: {}", e)),
        }
    }
}

fn redact_managed_codex_output(raw: &str) -> String {
    let mut redacted = String::new();
    for line in raw.lines() {
        if !redacted.is_empty() {
            redacted.push('\n');
        }
        for (idx, token) in line.split_whitespace().enumerate() {
            if idx > 0 {
                redacted.push(' ');
            }
            if token.starts_with("http://") || token.starts_with("https://") {
                redacted.push_str("<redacted-url>");
            } else if token.len() >= 24
                && token
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '=' | '/'))
            {
                redacted.push_str("<redacted-token>");
            } else {
                redacted.push_str(token);
            }
        }
    }
    if redacted.chars().count() > MAX_CAPTURED_OUTPUT_CHARS {
        redacted
            .chars()
            .take(MAX_CAPTURED_OUTPUT_CHARS)
            .collect::<String>()
            + "...<truncated>"
    } else {
        redacted
    }
}

fn combine_sanitized_output(stdout: String, stderr: String) -> String {
    redact_managed_codex_output(
        &[stdout, stderr]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

fn auth_state_from_login_status() -> ManagedCodexAuthState {
    if runtime_install_state().status != "installed" {
        return ManagedCodexAuthState {
            status: "unknown".to_string(),
            auth_method: None,
            account_email: None,
            verified_at: None,
            error: None,
        };
    }

    harden_managed_auth_file_permissions();

    match run_codex_capture(
        &[
            "-c",
            "cli_auth_credentials_store=\"file\"",
            "login",
            "status",
        ],
        Duration::from_secs(15),
    ) {
        Ok((true, stdout, stderr)) => {
            let combined = format!("{}\n{}", stdout, stderr).to_lowercase();
            if combined.contains("api key") {
                ManagedCodexAuthState {
                    status: "invalid".to_string(),
                    auth_method: Some("api-key".to_string()),
                    account_email: None,
                    verified_at: Some(now_iso()),
                    error: Some("Managed Codex Provider requires ChatGPT subscription login, not API key auth".to_string()),
                }
            } else {
                ManagedCodexAuthState {
                    status: "valid".to_string(),
                    auth_method: Some("chatgpt".to_string()),
                    account_email: None,
                    verified_at: Some(now_iso()),
                    error: None,
                }
            }
        }
        Ok((false, stdout, stderr)) => ManagedCodexAuthState {
            status: if format!("{}\n{}", stdout, stderr)
                .to_lowercase()
                .contains("not logged in")
            {
                "logged-out".to_string()
            } else {
                "invalid".to_string()
            },
            auth_method: None,
            account_email: None,
            verified_at: Some(now_iso()),
            error: Some(combine_sanitized_output(stdout, stderr)),
        },
        Err(err) => ManagedCodexAuthState {
            status: "error".to_string(),
            auth_method: None,
            account_email: None,
            verified_at: Some(now_iso()),
            error: Some(err),
        },
    }
}

fn config_path() -> Result<PathBuf, String> {
    Ok(data_dir()?.join("config.json"))
}

fn persist_status(
    install: &ManagedCodexRuntimeInstallState,
    auth: &ManagedCodexAuthState,
    disable_provider: bool,
) -> Result<(), String> {
    let path = config_path()?;
    let install_value = serde_json::to_value(install)
        .map_err(|e| format!("[managed-codex] Cannot serialize install state: {}", e))?;
    let auth_value = serde_json::to_value(auth)
        .map_err(|e| format!("[managed-codex] Cannot serialize auth state: {}", e))?;
    crate::config_io::with_config_lock(&path, false, move |config| {
        if !config.is_object() {
            *config = json!({});
        }
        let obj = config
            .as_object_mut()
            .ok_or_else(|| "[managed-codex] config root is not an object".to_string())?;
        obj.insert("managedCodexRuntimeInstall".to_string(), install_value);
        obj.insert("managedCodexAuth".to_string(), auth_value.clone());

        let provider_status = obj
            .entry("providerVerifyStatus".to_string())
            .or_insert_with(|| json!({}));
        if !provider_status.is_object() {
            *provider_status = json!({});
        }
        let provider_obj = provider_status
            .as_object_mut()
            .ok_or_else(|| "[managed-codex] providerVerifyStatus is not an object".to_string())?;
        let auth_status = auth_value
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        if auth_status == "valid" {
            provider_obj.insert(
                CODEX_PROVIDER_ID.to_string(),
                json!({
                    "status": "valid",
                    "verifiedAt": auth.verified_at.clone().unwrap_or_else(now_iso),
                    "accountEmail": auth.account_email.clone(),
                }),
            );
        } else if matches!(auth_status, "invalid" | "logged-out" | "error") {
            provider_obj.insert(
                CODEX_PROVIDER_ID.to_string(),
                json!({
                    "status": "invalid",
                    "verifiedAt": auth.verified_at.clone().unwrap_or_else(now_iso),
                }),
            );
            if disable_provider {
                obj.insert("managedCodexProviderEnabled".to_string(), json!(false));
            }
        }
        Ok(())
    })?;
    Ok(())
}

fn current_status_blocking() -> Result<ManagedCodexStatus, String> {
    let install = runtime_install_state();
    let auth = auth_state_from_login_status();
    persist_status(&install, &auth, false)?;
    let runtime_path = platform_key()
        .and_then(managed_codex_binary_path)
        .map(normalize_out_path);
    if install.status == "error" || auth.status == "error" || auth.status == "invalid" {
        ulog_warn!(
            "[managed-codex] status runtime=codex runtimeSource=managed-provider installStatus={} installedVersion={} platform={} authStatus={} authMethod={}",
            install.status,
            install.installed_version.as_deref().unwrap_or("<none>"),
            install.platform.as_deref().unwrap_or("<unsupported>"),
            auth.status,
            auth.auth_method.as_deref().unwrap_or("<none>")
        );
    } else {
        ulog_info!(
            "[managed-codex] status runtime=codex runtimeSource=managed-provider installStatus={} installedVersion={} platform={} authStatus={} authMethod={}",
            install.status,
            install.installed_version.as_deref().unwrap_or("<none>"),
            install.platform.as_deref().unwrap_or("<unsupported>"),
            auth.status,
            auth.auth_method.as_deref().unwrap_or("<none>")
        );
    }
    Ok(ManagedCodexStatus {
        runtime_install: install,
        auth,
        codex_home: codex_home().ok().map(normalize_out_path),
        runtime_path,
    })
}

#[tauri::command]
pub async fn cmd_managed_codex_status() -> Result<ManagedCodexStatus, String> {
    tauri::async_runtime::spawn_blocking(current_status_blocking)
        .await
        .map_err(|e| format!("[managed-codex] status task failed: {}", e))?
}

#[tauri::command]
pub async fn cmd_managed_codex_check_update() -> Result<ManagedCodexStatus, String> {
    cmd_managed_codex_status().await
}

#[tauri::command]
pub async fn cmd_managed_codex_download() -> Result<ManagedCodexStatus, String> {
    tauri::async_runtime::spawn_blocking(|| -> Result<ManagedCodexStatus, String> {
        with_runtime_install_lock(|| {
            let platform = platform_key().ok_or_else(|| {
                format!(
                    "Managed Codex does not support {}-{}",
                    std::env::consts::OS,
                    std::env::consts::ARCH
                )
            })?;
            ulog_info!(
                "[managed-codex] download requested runtime=codex runtimeSource=managed-provider version={} platform={} manifest={}",
                REQUIRED_VERSION,
                platform,
                MANIFEST_URL
            );

            let installed = runtime_install_state();
            if installed.status == "installed" {
                let auth = auth_state_from_login_status();
                persist_status(&installed, &auth, false)?;
                return Ok(ManagedCodexStatus {
                    runtime_install: installed,
                    auth,
                    codex_home: codex_home().ok().map(normalize_out_path),
                    runtime_path: managed_codex_binary_path(platform).map(normalize_out_path),
                });
            }

            let downloading = ManagedCodexRuntimeInstallState {
                status: "downloading".to_string(),
                required_version: Some(REQUIRED_VERSION.to_string()),
                installed_version: installed.installed_version.clone(),
                platform: Some(platform.to_string()),
                installed_at: installed.installed_at.clone(),
                last_checked_at: Some(now_iso()),
                error: None,
            };
            let current_auth = auth_state_from_login_status();
            persist_status(&downloading, &current_auth, false)?;

            let result = (|| -> Result<ManagedCodexStatus, String> {
                let client = external_http_client(Duration::from_secs(15 * 60))?;
                let manifest_bytes =
                    fetch_limited_bytes(&client, MANIFEST_URL, MAX_MANIFEST_BYTES, "manifest")?;
                let manifest: ManagedCodexManifest = serde_json::from_slice(&manifest_bytes)
                    .map_err(|e| format!("[managed-codex] Invalid manifest JSON: {}", e))?;
                let artifact = validate_manifest_for_platform(manifest, platform)?;

                let root = runtime_root()?;
                fs::create_dir_all(&root).map_err(|e| {
                    format!("[managed-codex] Failed to create runtime root: {}", e)
                })?;
                let tmp_dir = root.join(format!(
                    ".download-{}-{}-{}",
                    REQUIRED_VERSION,
                    platform,
                    uuid::Uuid::new_v4()
                ));
                fs::create_dir_all(&tmp_dir).map_err(|e| {
                    format!("[managed-codex] Failed to create download temp dir: {}", e)
                })?;
                let archive_path = tmp_dir.join("codex-runtime.zip");

                let cleanup_result = (|| -> Result<ManagedCodexStatus, String> {
                    let (downloaded_bytes, actual_sha) = download_to_file_with_hash(
                        &client,
                        &artifact.url,
                        &archive_path,
                        artifact.archive_size_bytes.unwrap_or(MAX_ARCHIVE_BYTES),
                    )?;
                    let expected_sha = normalize_sha256_hex(&artifact.sha256)?;
                    if let Some(expected_size) = artifact.archive_size_bytes {
                        if downloaded_bytes != expected_size {
                            return Err(format!(
                                "[managed-codex] Artifact size mismatch: expected {}, got {}",
                                expected_size, downloaded_bytes
                            ));
                        }
                    }
                    if actual_sha != expected_sha {
                        return Err(format!(
                            "[managed-codex] Artifact SHA-256 mismatch: expected {}, got {}",
                            expected_sha, actual_sha
                        ));
                    }
                    verify_minisign_file(&archive_path, &artifact.signature)?;
                    install_verified_artifact(platform, &artifact, &archive_path, &actual_sha)?;
                    ulog_info!(
                        "[managed-codex] download installed runtime=codex runtimeSource=managed-provider version={} platform={} bytes={} sha256={}",
                        REQUIRED_VERSION,
                        platform,
                        downloaded_bytes,
                        actual_sha
                    );
                    current_status_blocking()
                })();

                let _ = fs::remove_dir_all(&tmp_dir);
                cleanup_result
            })();

            match result {
                Ok(status) => Ok(status),
                Err(err) => {
                    let install = ManagedCodexRuntimeInstallState {
                        status: "error".to_string(),
                        required_version: Some(REQUIRED_VERSION.to_string()),
                        installed_version: installed.installed_version,
                        platform: Some(platform.to_string()),
                        installed_at: installed.installed_at,
                        last_checked_at: Some(now_iso()),
                        error: Some(err.clone()),
                    };
                    let auth = auth_state_from_login_status();
                    persist_status(&install, &auth, false)?;
                    ulog_error!(
                        "[managed-codex] download failed runtime=codex runtimeSource=managed-provider platform={} error={}",
                        platform,
                        err
                    );
                    Err(err)
                }
            }
        })
    })
    .await
    .map_err(|e| format!("[managed-codex] download task failed: {}", e))?
}

#[tauri::command]
pub async fn cmd_managed_codex_login() -> Result<ManagedCodexStatus, String> {
    tauri::async_runtime::spawn_blocking(|| -> Result<ManagedCodexStatus, String> {
        ulog_info!("[managed-codex] login start runtime=codex runtimeSource=managed-provider");
        let install = runtime_install_state();
        if install.status != "installed" {
            let err = "Managed Codex runtime must be installed before login".to_string();
            let auth = ManagedCodexAuthState {
                status: "error".to_string(),
                auth_method: None,
                account_email: None,
                verified_at: Some(now_iso()),
                error: Some(err.clone()),
            };
            persist_status(&install, &auth, false)?;
            return Err(err);
        }
        let (ok, stdout, stderr) = run_codex_capture(
            &[
                "-c",
                "cli_auth_credentials_store=\"file\"",
                "-c",
                "forced_login_method=\"chatgpt\"",
                "login",
            ],
            Duration::from_secs(300),
        )?;
        if !ok {
            let message = combine_sanitized_output(stdout, stderr);
            let auth = ManagedCodexAuthState {
                status: "error".to_string(),
                auth_method: None,
                account_email: None,
                verified_at: Some(now_iso()),
                error: Some(if message.is_empty() {
                    "Codex login failed".to_string()
                } else {
                    message
                }),
            };
            persist_status(&install, &auth, false)?;
            return Err(auth
                .error
                .unwrap_or_else(|| "Codex login failed".to_string()));
        }
        let status = current_status_blocking()?;
        ulog_info!(
            "[managed-codex] login done runtime=codex runtimeSource=managed-provider authStatus={}",
            status.auth.status
        );
        Ok(status)
    })
    .await
    .map_err(|e| format!("[managed-codex] login task failed: {}", e))?
}

#[tauri::command]
pub async fn cmd_managed_codex_logout() -> Result<ManagedCodexStatus, String> {
    tauri::async_runtime::spawn_blocking(|| -> Result<ManagedCodexStatus, String> {
        ulog_info!("[managed-codex] logout start runtime=codex runtimeSource=managed-provider");
        if runtime_install_state().status == "installed" {
            match run_codex_capture(
                &["-c", "cli_auth_credentials_store=\"file\"", "logout"],
                Duration::from_secs(30),
            ) {
                Ok((true, _, _)) => {}
                Ok((false, stdout, stderr)) => {
                    ulog_warn!(
                        "[managed-codex] codex logout exited non-zero stdout={} stderr={}",
                        redact_managed_codex_output(&stdout),
                        redact_managed_codex_output(&stderr)
                    );
                }
                Err(err) => {
                    ulog_warn!("[managed-codex] codex logout failed: {}", err);
                }
            }
        }
        if let Ok(auth_file) = managed_auth_file() {
            remove_path_entry(&auth_file)
                .map_err(|e| format!("[managed-codex] Cannot remove managed auth file: {}", e))?;
        }
        let install = runtime_install_state();
        let auth = ManagedCodexAuthState {
            status: "logged-out".to_string(),
            auth_method: None,
            account_email: None,
            verified_at: Some(now_iso()),
            error: None,
        };
        persist_status(&install, &auth, true)?;
        ulog_info!("[managed-codex] logout done runtime=codex runtimeSource=managed-provider");
        Ok(ManagedCodexStatus {
            runtime_install: install,
            auth,
            codex_home: codex_home().ok().map(normalize_out_path),
            runtime_path: platform_key()
                .and_then(managed_codex_binary_path)
                .map(normalize_out_path),
        })
    })
    .await
    .map_err(|e| format!("[managed-codex] logout task failed: {}", e))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_artifact() -> ManagedCodexArtifact {
        ManagedCodexArtifact {
            url: "https://download.myagents.io/runtimes/codex/releases/v0.142.2/codex-darwin-arm64.zip".to_string(),
            sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".to_string(),
            signature: "placeholder-signature".to_string(),
            executable_relative_path: "bin/codex".to_string(),
            archive_type: "zip".to_string(),
            archive_size_bytes: Some(10 * 1024 * 1024),
            unpacked_size_bytes: Some(20 * 1024 * 1024),
            entry_count: Some(12),
        }
    }

    fn valid_manifest(platform: &str) -> ManagedCodexManifest {
        ManagedCodexManifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            app_version: REQUIRED_APP_RUNTIME_SET.to_string(),
            codex_version: REQUIRED_VERSION.to_string(),
            artifacts: HashMap::from([(platform.to_string(), valid_artifact())]),
        }
    }

    #[test]
    fn platform_key_is_limited_to_v1_targets() {
        let key = platform_key();
        if cfg!(target_os = "macos") {
            assert!(matches!(key, Some("darwin-arm64") | Some("darwin-x64")));
        } else if cfg!(target_os = "windows") && cfg!(target_arch = "x86_64") {
            assert_eq!(key, Some("win32-x64"));
        } else {
            assert_eq!(key, None);
        }
    }

    #[test]
    fn runtime_state_missing_metadata_is_not_installed_or_unsupported() {
        let state = runtime_install_state();
        assert_eq!(state.required_version.as_deref(), Some(REQUIRED_VERSION));
        assert!(matches!(
            state.status.as_str(),
            "not-installed" | "error" | "installed" | "update-required"
        ));
    }

    #[test]
    fn auth_status_requires_chatgpt_not_api_key() {
        let fake_api_key_output = "Logged in with API key";
        let combined = fake_api_key_output.to_lowercase();
        assert!(combined.contains("api key"));
    }

    #[test]
    fn manifest_accepts_valid_locked_platform_artifact() {
        let artifact =
            validate_manifest_for_platform(valid_manifest("darwin-arm64"), "darwin-arm64")
                .expect("valid manifest");
        assert_eq!(artifact.archive_type, "zip");
        assert_eq!(artifact.executable_relative_path, "bin/codex");
    }

    #[test]
    fn manifest_rejects_wrong_version_or_missing_platform() {
        let mut wrong_version = valid_manifest("darwin-arm64");
        wrong_version.codex_version = "0.999.0".to_string();
        assert!(
            validate_manifest_for_platform(wrong_version, "darwin-arm64")
                .unwrap_err()
                .contains("codexVersion mismatch")
        );

        assert!(
            validate_manifest_for_platform(valid_manifest("darwin-arm64"), "win32-x64")
                .unwrap_err()
                .contains("no artifact")
        );
    }

    #[test]
    fn manifest_rejects_non_myagents_https_urls() {
        let mut manifest = valid_manifest("darwin-arm64");
        manifest.artifacts.get_mut("darwin-arm64").unwrap().url =
            "https://example.com/runtimes/codex/codex.zip".to_string();
        assert!(validate_manifest_for_platform(manifest, "darwin-arm64")
            .unwrap_err()
            .contains("download.myagents.io"));

        let mut manifest = valid_manifest("darwin-arm64");
        manifest.artifacts.get_mut("darwin-arm64").unwrap().url =
            "http://download.myagents.io/runtimes/codex/codex.zip".to_string();
        assert!(validate_manifest_for_platform(manifest, "darwin-arm64")
            .unwrap_err()
            .contains("HTTPS"));
    }

    #[test]
    fn archive_paths_reject_traversal_absolute_and_windows_reserved_names() {
        assert!(validate_relative_archive_path("bin/codex").is_ok());
        assert!(validate_relative_archive_path("../codex").is_err());
        assert!(validate_relative_archive_path("/bin/codex").is_err());
        assert!(validate_relative_archive_path("bin\\codex.exe").is_err());
        assert!(validate_relative_archive_path("CON").is_err());
        assert!(validate_relative_archive_path("bin/codex:bad").is_err());
    }

    #[test]
    fn executable_path_is_limited_to_codex_binary_names() {
        assert!(validate_executable_relative_path("bin/codex").is_ok());
        assert!(validate_executable_relative_path("bin/codex.exe").is_ok());
        assert!(validate_executable_relative_path("bin/node").is_err());
        assert!(validate_executable_relative_path("bin/codex/").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn path_entry_helpers_treat_broken_symlink_as_existing_entry() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let broken_link = dir.path().join("auth.json");
        symlink(dir.path().join("missing-target"), &broken_link).unwrap();

        assert!(has_path_entry(&broken_link).unwrap());
        remove_path_entry(&broken_link).unwrap();
        assert!(!has_path_entry(&broken_link).unwrap());
    }

    #[test]
    fn managed_codex_pubkey_matches_tauri_updater_pubkey() {
        let conf_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json");
        let content = fs::read_to_string(conf_path).expect("tauri.conf.json");
        let json: serde_json::Value = serde_json::from_str(&content).expect("valid tauri config");
        let updater_pubkey = json
            .get("plugins")
            .and_then(|v| v.get("updater"))
            .and_then(|v| v.get("pubkey"))
            .and_then(|v| v.as_str())
            .expect("updater pubkey");
        assert_eq!(updater_pubkey, MYAGENTS_MINISIGN_PUBKEY);
    }
}
