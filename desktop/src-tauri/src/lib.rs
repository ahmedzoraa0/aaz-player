use base64::Engine as _;
use minisign_verify::{PublicKey, Signature};
use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::cmp::Ordering as CmpOrdering;
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::{Ipv4Addr, Shutdown, TcpListener, TcpStream, UdpSocket};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};
use tauri::http::{header, Method, Response, StatusCode};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, Position, Size,
    State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

mod taskbar;

const REPO_CONFIG_JSON: &str = include_str!("repo_config.json");

static WINDOW_COUNTER: AtomicU64 = AtomicU64::new(1);

const MAX_UPDATE_DOWNLOAD_BYTES: u64 = 150 * 1024 * 1024; // 150 MB hard cap
const MAX_TEXT_FILE_BYTES: u64 = 16 * 1024 * 1024; // 16 MB max subtitle/playlist text file
const MAX_DLNA_XML_BYTES: u64 = 256 * 1024; // 256 KB max UPnP XML description
const MAX_HTTP_REQUEST_LINE_BYTES: usize = 2048;
const MAX_HTTP_HEADERS: usize = 32;
const MAX_HTTP_HEADER_BYTES: usize = 8192;
const HTTP_HEADER_TIMEOUT_SECS: u64 = 5;
const MAX_CAST_CONCURRENT_CONNECTIONS: usize = 8;
const MAX_SSDP_LOCATIONS: usize = 32;
const MAX_SSDP_PACKETS: usize = 256;
const MAX_DIR_SCAN_DEPTH: usize = 24;
const MAX_DIR_SCAN_ENTRIES: usize = 25_000;

const AUDIO_EXTS: &[&str] = &[
    "mp3", "wav", "flac", "ogg", "oga", "m4a", "aac", "opus", "wma", "aiff", "aif", "aifc", "alac",
    "weba", "mka", "mp2", "amr", "caf", "ac3", "dts", "wv", "ape",
];

const VIDEO_EXTS: &[&str] = &[
    "mp4", "webm", "mkv", "mov", "m4v", "avi", "ogv", "3gp", "3g2", "ts", "mts", "m2ts", "flv",
    "wmv", "mpg", "mpeg",
];

const SUBTITLE_EXTS: &[&str] = &["srt", "vtt"];
const PLAYLIST_EXTS: &[&str] = &["xspf", "m3u8", "m3u", "pls"];

const SUB_NOISE_TOKENS: &[&str] = &[
    "1080p",
    "720p",
    "480p",
    "2160p",
    "4k",
    "uhd",
    "hd",
    "sd",
    "hdr",
    "hdr10",
    "bluray",
    "bdrip",
    "brrip",
    "webrip",
    "webdl",
    "web",
    "dl",
    "hdtv",
    "dvdrip",
    "cam",
    "ts",
    "x264",
    "x265",
    "h264",
    "h265",
    "hevc",
    "avc",
    "xvid",
    "10bit",
    "8bit",
    "aac",
    "ac3",
    "dts",
    "ddp5",
    "dd5",
    "atmos",
    "mp3",
    "flac",
    "yts",
    "yify",
    "rarbg",
    "etrg",
    "evo",
    "nf",
    "amzn",
    "dsnp",
    "hmax",
    "extended",
    "unrated",
    "repack",
    "proper",
    "ar",
    "ara",
    "arabic",
    "en",
    "eng",
    "english",
    "sub",
    "subs",
    "subtitle",
    "subtitles",
    "sdh",
    "hi",
    "forced",
    "cc",
];

struct CastServerState {
    running: Arc<AtomicBool>,
    port: u16,
    lan_ip: String,
    session_token: Arc<Mutex<String>>,
    media_path: Arc<Mutex<Option<PathBuf>>>,
    media_title: Arc<Mutex<String>>,
    subtitle_vtt: Arc<Mutex<Option<String>>>,
    active_streams: Arc<Mutex<Vec<(u64, TcpStream)>>>,
}

#[derive(Default)]
struct AppState {
    launch_files: Mutex<Vec<String>>,
    cached_fonts: Mutex<Option<Vec<String>>>,
    pending_update_url: Mutex<Option<String>>,
    pending_update_version: Mutex<Option<String>>,
    pending_update_asset_name: Mutex<Option<String>>,
    pending_update_sha256: Mutex<Option<String>>,
    pending_update_signature: Mutex<Option<String>>,
    downloaded_installer: Mutex<Option<PathBuf>>,
    downloaded_installer_version: Mutex<Option<String>>,
    downloaded_installer_asset_name: Mutex<Option<String>>,
    downloaded_installer_sha256: Mutex<Option<String>>,
    downloaded_installer_signature: Mutex<Option<String>>,
    update_downloading: AtomicBool,
    cast_server: Mutex<Option<CastServerState>>,
    authorized_files: Mutex<HashSet<PathBuf>>,
    authorized_dirs: Mutex<HashSet<PathBuf>>,
    discovered_dlna_controls: Mutex<HashSet<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepoConfig {
    repo: String,
    #[serde(default)]
    updater_public_key: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct MediaEntry {
    key: String,
    name: String,
    folder_path: String,
    full_path: String,
    file_url: String,
    kind: String,
    ext: String,
    size: u64,
    mtime_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderResult {
    folder_path: String,
    folder_name: String,
    entries: Vec<MediaEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PlaylistEntry {
    name: String,
    full_path: String,
    content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InspectResult {
    is_directory: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    folder_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    folder_name: Option<String>,
    entries: Vec<MediaEntry>,
    playlists: Vec<PlaylistEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NearbySubtitle {
    name: String,
    full_path: String,
    text: String,
    score: i32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveSnapshotResult {
    saved: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CastServerInfo {
    lan_ip: String,
    port: u16,
    receiver_url: String,
    media_url: String,
    subtitle_url: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CastDevice {
    id: String,
    name: String,
    manufacturer: String,
    control_url: String,
    location: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct MonitorRect {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct WindowGeometry {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    maximized: bool,
    scale_factor: f64,
    monitors: Vec<MonitorRect>,
}

#[derive(Debug, PartialEq, Eq)]
enum HttpRangeError {
    Malformed,
    Unsatisfiable,
}

fn is_ext_in(ext: &str, list: &[&str]) -> bool {
    list.iter().any(|&item| item.eq_ignore_ascii_case(ext))
}

fn is_supported_media_or_subtitle_ext(ext: &str) -> bool {
    is_ext_in(ext, AUDIO_EXTS) || is_ext_in(ext, VIDEO_EXTS) || is_ext_in(ext, SUBTITLE_EXTS)
}

fn is_supported_media_ext(ext: &str) -> bool {
    is_ext_in(ext, AUDIO_EXTS) || is_ext_in(ext, VIDEO_EXTS)
}

fn is_supported_text_ext(ext: &str) -> bool {
    is_ext_in(ext, SUBTITLE_EXTS) || is_ext_in(ext, PLAYLIST_EXTS)
}

fn path_ext_lower(path: &Path) -> String {
    path.extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default()
}

fn file_mtime_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn build_media_url(full_path: &Path) -> String {
    let raw = full_path.to_string_lossy();
    let encoded = utf8_percent_encode(raw.as_ref(), NON_ALPHANUMERIC).to_string();
    format!("http://aazmedia.localhost/file?path={encoded}")
}

fn authorize_file_path(state: &AppState, path: &Path) {
    if let Ok(canon) = fs::canonicalize(path) {
        if canon.is_file() {
            let ext = path_ext_lower(&canon);
            if is_supported_media_or_subtitle_ext(&ext) || is_ext_in(&ext, PLAYLIST_EXTS) {
                if let Ok(mut guard) = state.authorized_files.lock() {
                    guard.insert(canon);
                }
            }
        }
    }
}

fn authorize_dir_path(state: &AppState, dir: &Path) {
    if let Ok(canon) = fs::canonicalize(dir) {
        if canon.is_dir() {
            if let Ok(mut guard) = state.authorized_dirs.lock() {
                guard.insert(canon);
            }
        }
    }
}

fn validate_authorized_media_path(
    raw_path: &str,
    authorized_files: &HashSet<PathBuf>,
    authorized_dirs: &HashSet<PathBuf>,
    require_audio_or_video_only: bool,
) -> Result<PathBuf, StatusCode> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() || trimmed.contains('\0') {
        return Err(StatusCode::BAD_REQUEST);
    }

    let canon = fs::canonicalize(Path::new(trimmed)).map_err(|_| StatusCode::NOT_FOUND)?;
    let meta = fs::metadata(&canon).map_err(|_| StatusCode::NOT_FOUND)?;
    if !meta.is_file() {
        return Err(StatusCode::FORBIDDEN);
    }

    let ext = path_ext_lower(&canon);
    let ext_ok = if require_audio_or_video_only {
        is_supported_media_ext(&ext)
    } else {
        is_supported_media_or_subtitle_ext(&ext)
    };
    if !ext_ok {
        return Err(StatusCode::FORBIDDEN);
    }

    let allowed = authorized_files.contains(&canon)
        || authorized_dirs.iter().any(|dir| canon.starts_with(dir));
    if !allowed {
        return Err(StatusCode::FORBIDDEN);
    }

    Ok(canon)
}

fn parse_http_range(
    range_val: &str,
    file_len: u64,
    max_chunk: Option<u64>,
) -> Result<(u64, u64), HttpRangeError> {
    if file_len == 0 {
        return Err(HttpRangeError::Unsatisfiable);
    }
    let trimmed = range_val.trim();
    let spec = trimmed
        .strip_prefix("bytes=")
        .or_else(|| trimmed.strip_prefix("BYTES="))
        .ok_or(HttpRangeError::Malformed)?;
    let first_range = spec.split(',').next().unwrap_or("").trim();
    let (start_s, end_s) = first_range
        .split_once('-')
        .ok_or(HttpRangeError::Malformed)?;
    let start_s = start_s.trim();
    let end_s = end_s.trim();

    if start_s.is_empty() && end_s.is_empty() {
        return Err(HttpRangeError::Malformed);
    }

    if start_s.is_empty() {
        let suffix: u64 = end_s.parse().map_err(|_| HttpRangeError::Malformed)?;
        if suffix == 0 {
            return Err(HttpRangeError::Unsatisfiable);
        }
        let start = file_len.saturating_sub(suffix);
        let mut end = file_len - 1;
        if let Some(cap) = max_chunk {
            end = end.min(start.saturating_add(cap.saturating_sub(1)));
        }
        return Ok((start, end));
    }

    let start: u64 = start_s.parse().map_err(|_| HttpRangeError::Malformed)?;
    if start >= file_len {
        return Err(HttpRangeError::Unsatisfiable);
    }

    let mut end = if end_s.is_empty() {
        file_len - 1
    } else {
        let parsed_end: u64 = end_s.parse().map_err(|_| HttpRangeError::Malformed)?;
        if parsed_end < start {
            return Err(HttpRangeError::Unsatisfiable);
        }
        parsed_end.min(file_len - 1)
    };

    if let Some(cap) = max_chunk {
        end = end.min(start.saturating_add(cap.saturating_sub(1)));
    }

    Ok((start, end))
}

fn generate_session_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes)
        .map_err(|e| format!("Failed to generate session token: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    let ab = a.as_bytes();
    let bb = b.as_bytes();
    if ab.len() != bb.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (&x, &y) in ab.iter().zip(bb.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

fn build_http_response(
    status: StatusCode,
    content_type: Option<&str>,
    body: Vec<u8>,
) -> Response<Vec<u8>> {
    let mut builder = Response::builder()
        .status(status)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header("Cross-Origin-Resource-Policy", "cross-origin");
    if let Some(ct) = content_type {
        builder = builder.header(header::CONTENT_TYPE, ct);
    }
    builder
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn validate_repo_slug(repo: &str) -> bool {
    let trimmed = repo.trim();
    let Some((owner, name)) = trimmed.split_once('/') else {
        return false;
    };
    if owner.is_empty() || name.is_empty() || name.contains('/') {
        return false;
    }
    let valid_part = |s: &str| {
        !s.starts_with('.')
            && !s.contains("..")
            && s.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    };
    valid_part(owner) && valid_part(name)
}

fn sanitize_version_for_filename(ver: &str) -> String {
    let cleaned: String = ver
        .trim()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        .take(32)
        .collect();
    if cleaned.is_empty() || cleaned.starts_with('.') || cleaned.contains("..") {
        "latest".to_string()
    } else {
        cleaned
    }
}

fn extract_https_host_and_path(raw_url: &str) -> Option<(String, String)> {
    let trimmed = raw_url.trim();
    if trimmed.is_empty() || trimmed.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return None;
    }
    let rest = trimmed.strip_prefix("https://")?;
    let (authority, path) = match rest.find('/') {
        Some(idx) => (&rest[..idx], &rest[idx..]),
        None => (rest, "/"),
    };
    if authority.is_empty() || authority.contains('@') {
        return None;
    }
    let (host, port_opt) = match authority.split_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (authority, None),
    };
    if let Some(port) = port_opt {
        if port != "443" {
            return None;
        }
    }
    if host.is_empty() || path.contains("..") {
        return None;
    }
    Some((host.to_ascii_lowercase(), path.to_string()))
}

fn validate_update_download_url(raw_url: &str, repo: &str) -> Result<(), String> {
    if !validate_repo_slug(repo) {
        return Err("Invalid repository configuration.".to_string());
    }
    let (host, path) = extract_https_host_and_path(raw_url)
        .ok_or_else(|| "Update URL must use HTTPS on a trusted GitHub host.".to_string())?;
    let expected_prefix = format!("/{}/releases/download/", repo.to_ascii_lowercase());
    match host.as_str() {
        "github.com" => {
            if path.to_ascii_lowercase().starts_with(&expected_prefix) {
                Ok(())
            } else {
                Err("Update URL path does not match the configured repository release.".to_string())
            }
        }
        "objects.githubusercontent.com"
        | "release-assets.githubusercontent.com"
        | "github-releases.githubusercontent.com" => Ok(()),
        _ => Err("Update URL host is not an allowlisted GitHub release domain.".to_string()),
    }
}

fn parse_sha256_hex(raw: &str) -> Option<String> {
    let cleaned = raw
        .trim()
        .strip_prefix("sha256:")
        .or_else(|| raw.trim().strip_prefix("SHA256:"))
        .unwrap_or(raw.trim())
        .trim();
    if cleaned.len() == 64 && cleaned.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(cleaned.to_ascii_lowercase())
    } else {
        None
    }
}

fn find_checksum_in_sums_text(content: &str, asset_name: &str) -> Option<String> {
    let target = asset_name.to_ascii_lowercase();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let mut parts = trimmed.split_whitespace();
        let Some(hash_candidate) = parts.next() else {
            continue;
        };
        let Some(valid_hash) = parse_sha256_hex(hash_candidate) else {
            continue;
        };
        let rest_name = parts
            .next()
            .map(|s| s.trim_start_matches('*').to_ascii_lowercase());
        match rest_name {
            Some(fname) if fname == target || fname.ends_with(&format!("/{target}")) => {
                return Some(valid_hash);
            }
            None if content.lines().count() == 1 => return Some(valid_hash),
            _ => {}
        }
    }
    None
}

fn parse_minisign_public_key(raw: &str) -> Result<PublicKey, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("Update signing public key is not configured in this build.".to_string());
    }
    if trimmed.contains('\n') {
        PublicKey::decode(trimmed)
            .map_err(|_| "Configured update signing public key is invalid.".to_string())
    } else {
        PublicKey::from_base64(trimmed)
            .map_err(|_| "Configured update signing public key is invalid.".to_string())
    }
}

fn verify_file_integrity(
    path: &Path,
    expected_sha256: &str,
    expected_size: Option<u64>,
) -> Result<String, String> {
    let expected_norm = parse_sha256_hex(expected_sha256).ok_or_else(|| {
        "Update refused: missing or malformed expected SHA-256 checksum.".to_string()
    })?;
    let mut file =
        File::open(path).map_err(|_| "Could not open downloaded update file.".to_string())?;
    let meta = file
        .metadata()
        .map_err(|_| "Could not read update file metadata.".to_string())?;
    if !meta.is_file() || meta.len() < 64 {
        return Err("Update file is empty or incomplete.".to_string());
    }
    if meta.len() > MAX_UPDATE_DOWNLOAD_BYTES {
        return Err("Update file exceeds maximum permitted size.".to_string());
    }
    if let Some(exp_len) = expected_size {
        if exp_len > 0 && meta.len() != exp_len {
            return Err("Downloaded update file size does not match Content-Length.".to_string());
        }
    }

    let mut header_bytes = [0u8; 2];
    file.read_exact(&mut header_bytes)
        .map_err(|_| "Failed to read executable header.".to_string())?;
    if &header_bytes != b"MZ" {
        return Err("Downloaded file is not a valid Windows executable.".to_string());
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|_| "Failed to seek downloaded file.".to_string())?;

    let mut hasher = Sha256::new();
    let mut buf = [0u8; 32768];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|_| "Failed reading update file during hash verification.".to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    let digest: String = hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();

    if !constant_time_eq(&digest, &expected_norm) {
        return Err("Update checksum mismatch — file may be corrupted or tampered.".to_string());
    }

    Ok(digest)
}

fn validate_minisign_trusted_comment(
    trusted_comment: &str,
    expected_version: &str,
    expected_asset_name: &str,
    expected_sha256: &str,
) -> Result<(), String> {
    let trimmed = trusted_comment.trim();
    if let Some(rest) = trimmed.strip_prefix("aaz-player|") {
        let mut seen_version: Option<&str> = None;
        let mut seen_file: Option<&str> = None;
        let mut seen_sha256: Option<&str> = None;
        for part in rest.split('|') {
            if let Some((k, v)) = part.split_once('=') {
                match k.trim() {
                    "version" => seen_version = Some(v.trim()),
                    "file" => seen_file = Some(v.trim()),
                    "sha256" => seen_sha256 = Some(v.trim()),
                    _ => {}
                }
            }
        }
        let exp_ver = expected_version.trim().trim_start_matches(['v', 'V']);
        let exp_sha = expected_sha256.trim().to_ascii_lowercase();
        let ver_ok = seen_version
            .map(|v| {
                v.trim_start_matches(['v', 'V'])
                    .eq_ignore_ascii_case(exp_ver)
            })
            .unwrap_or(false);
        let file_ok = seen_file
            .map(|f| f.eq_ignore_ascii_case(expected_asset_name.trim()))
            .unwrap_or(false);
        let sha_ok = seen_sha256
            .and_then(parse_sha256_hex)
            .map(|h| constant_time_eq(&h, &exp_sha))
            .unwrap_or(false);
        if !ver_ok || !file_ok || !sha_ok {
            return Err(
                "Update refused: signed metadata does not match release version, file, or digest."
                    .to_string(),
            );
        }
        return Ok(());
    }

    // Standard minisign trusted comments (e.g. "timestamp:...\tfile:NAME") are checked if file: is present
    for token in trimmed.split(['\t', ' ']) {
        if let Some(signed_file) = token.strip_prefix("file:") {
            if !signed_file.eq_ignore_ascii_case(expected_asset_name.trim()) {
                return Err(
                    "Update refused: signed filename does not match the release installer."
                        .to_string(),
                );
            }
        }
    }
    Ok(())
}

fn verify_file_minisign(
    path: &Path,
    signature_text: &str,
    public_key: &PublicKey,
) -> Result<(), String> {
    let trimmed_sig = signature_text.trim();
    if trimmed_sig.is_empty() {
        return Err("Update refused: missing cryptographic signature.".to_string());
    }
    let signature = Signature::decode(trimmed_sig)
        .map_err(|_| "Update refused: malformed cryptographic signature.".to_string())?;
    let mut verifier = public_key
        .verify_stream(&signature)
        .map_err(|_| "Update refused: unsupported or invalid signature algorithm.".to_string())?;
    let mut file = File::open(path)
        .map_err(|_| "Could not open update file for signature check.".to_string())?;
    let mut buf = [0u8; 32768];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|_| "Failed reading update file during signature verification.".to_string())?;
        if n == 0 {
            break;
        }
        verifier.update(&buf[..n]);
    }
    verifier.finalize().map_err(|_| {
        "Update cryptographic signature verification failed — file may be untrusted.".to_string()
    })
}

fn verify_file_minisign_with_metadata(
    path: &Path,
    signature_text: &str,
    public_key: &PublicKey,
    expected_version: &str,
    expected_asset_name: &str,
    expected_sha256: &str,
) -> Result<(), String> {
    verify_file_minisign(path, signature_text, public_key)?;
    let signature = Signature::decode(signature_text.trim())
        .map_err(|_| "Update refused: malformed cryptographic signature.".to_string())?;
    validate_minisign_trusted_comment(
        signature.trusted_comment(),
        expected_version,
        expected_asset_name,
        expected_sha256,
    )
}

fn is_cgnat_ipv4(ip: Ipv4Addr) -> bool {
    let o = ip.octets();
    o[0] == 100 && (o[1] & 0xC0) == 64
}

fn is_allowed_lan_ipv4(ip: Ipv4Addr) -> bool {
    if ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_multicast()
        || ip.is_broadcast()
        || ip.is_documentation()
    {
        return false;
    }
    ip.is_private() || is_cgnat_ipv4(ip)
}

fn validate_lan_http_url(raw_url: &str) -> Result<String, String> {
    let trimmed = raw_url.trim();
    if trimmed.is_empty() || trimmed.len() > 1024 {
        return Err("Invalid DLNA device URL length.".to_string());
    }
    if trimmed.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err("Invalid characters in DLNA device URL.".to_string());
    }

    let (scheme, rest) = if let Some(r) = trimmed.strip_prefix("http://") {
        ("http", r)
    } else if let Some(r) = trimmed.strip_prefix("https://") {
        ("https", r)
    } else {
        return Err("DLNA URL must use http:// or https://.".to_string());
    };

    let (authority, path) = match rest.find('/') {
        Some(idx) => (&rest[..idx], &rest[idx..]),
        None => (rest, "/"),
    };
    if authority.is_empty() || authority.contains('@') {
        return Err("DLNA URL authority is invalid.".to_string());
    }

    let (host, port_opt) = match authority.split_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (authority, None),
    };
    if let Some(port_s) = port_opt {
        let port: u16 = port_s
            .parse()
            .map_err(|_| "Invalid port in DLNA URL.".to_string())?;
        if port == 0 {
            return Err("Invalid zero port in DLNA URL.".to_string());
        }
    }

    let ip: Ipv4Addr = host
        .parse()
        .map_err(|_| "DLNA target host must be a direct private LAN IPv4 address.".to_string())?;

    if !is_allowed_lan_ipv4(ip) {
        return Err("DLNA target IP is outside private LAN ranges.".to_string());
    }

    let normalized_authority = match port_opt {
        Some(p) => format!("{ip}:{p}"),
        None => ip.to_string(),
    };
    Ok(format!("{scheme}://{normalized_authority}{path}"))
}

fn clamp_window_geometry_to_monitors(
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    min_w: u32,
    min_h: u32,
    monitors: &[MonitorRect],
) -> (i32, i32, u32, u32) {
    let mut w = width.max(min_w);
    let mut h = height.max(min_h);
    if monitors.is_empty() {
        return (x.max(0), y.max(0), w, h);
    }

    let center_x = x as i64 + (w as i64) / 2;
    let center_y = y as i64 + (h as i64) / 2;

    let target = monitors
        .iter()
        .find(|m| {
            center_x >= m.x as i64
                && center_x <= m.x as i64 + m.width as i64
                && center_y >= m.y as i64
                && center_y <= m.y as i64 + m.height as i64
        })
        .unwrap_or(&monitors[0]);

    let max_w = target.width.max(min_w);
    let max_h = target.height.max(min_h);
    w = w.min(max_w);
    h = h.min(max_h);

    let min_x = target.x;
    let min_y = target.y;
    let max_x = target.x + (target.width.saturating_sub(w)) as i32;
    let max_y = target.y + (target.height.saturating_sub(h)) as i32;

    let clamped_x = x.clamp(min_x, max_x.max(min_x));
    let clamped_y = y.clamp(min_y, max_y.max(min_y));
    (clamped_x, clamped_y, w, h)
}

fn mime_for_ext(ext: &str) -> &'static str {
    match ext {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "mov" => "video/quicktime",
        "avi" => "video/x-msvideo",
        "ogv" => "video/ogg",
        "3gp" => "video/3gpp",
        "ts" | "mts" | "m2ts" => "video/mp2t",
        "flv" => "video/x-flv",
        "wmv" => "video/x-ms-wmv",
        "mpg" | "mpeg" => "video/mpeg",
        "mp3" | "mp2" => "audio/mpeg",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "ogg" | "oga" => "audio/ogg",
        "opus" => "audio/opus",
        "m4a" | "aac" | "alac" => "audio/mp4",
        "weba" => "audio/webm",
        "wma" => "audio/x-ms-wma",
        "aiff" | "aif" | "aifc" => "audio/aiff",
        "mka" => "audio/x-matroska",
        "srt" => "text/plain; charset=utf-8",
        "vtt" => "text/vtt; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn decode_text_smart(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        let (cow, _, _) = encoding_rs::UTF_16LE.decode(bytes);
        return cow.trim_start_matches('\u{feff}').to_string();
    }
    if bytes.len() >= 2 && bytes[0] == 0xFE && bytes[1] == 0xFF {
        let (cow, _, _) = encoding_rs::UTF_16BE.decode(bytes);
        return cow.trim_start_matches('\u{feff}').to_string();
    }
    if let Ok(utf8) = std::str::from_utf8(bytes) {
        return utf8.trim_start_matches('\u{feff}').to_string();
    }
    let (cow, _, _) = encoding_rs::WINDOWS_1256.decode(bytes);
    cow.into_owned()
}

fn scan_local_directory(current_dir: &Path, rel_prefix: &str, out: &mut Vec<MediaEntry>) {
    scan_local_directory_inner(current_dir, rel_prefix, 0, out);
}

fn scan_local_directory_inner(
    current_dir: &Path,
    rel_prefix: &str,
    depth: usize,
    out: &mut Vec<MediaEntry>,
) {
    if depth >= MAX_DIR_SCAN_DEPTH || out.len() >= MAX_DIR_SCAN_ENTRIES {
        return;
    }
    let entries = match fs::read_dir(current_dir) {
        Ok(rd) => rd,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        if out.len() >= MAX_DIR_SCAN_ENTRIES {
            break;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let full_path = entry.path();
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(_) => continue,
        };

        if file_type.is_dir() {
            let next_prefix = format!("{rel_prefix}{name}/");
            scan_local_directory_inner(&full_path, &next_prefix, depth + 1, out);
        } else if file_type.is_file() {
            let ext = path_ext_lower(&full_path);
            let kind = if is_ext_in(&ext, VIDEO_EXTS) {
                "video"
            } else if is_ext_in(&ext, AUDIO_EXTS) {
                "audio"
            } else if is_ext_in(&ext, SUBTITLE_EXTS) {
                "subtitle"
            } else {
                continue;
            };

            let size = fs::metadata(&full_path).map(|m| m.len()).unwrap_or(0);
            let mtime_ms = file_mtime_ms(&full_path);
            let folder_path = rel_prefix.trim_end_matches('/').to_string();
            let key = format!("{rel_prefix}{name}");
            out.push(MediaEntry {
                key,
                name,
                folder_path,
                full_path: full_path.to_string_lossy().into_owned(),
                file_url: build_media_url(&full_path),
                kind: kind.to_string(),
                ext: ext.to_ascii_uppercase(),
                size,
                mtime_ms,
            });
        }
    }
}

fn extract_supported_paths_from_argv(argv: &[String]) -> Vec<String> {
    argv.iter()
        .skip(1)
        .filter(|arg| !arg.starts_with('-') && arg.as_str() != ".")
        .filter_map(|arg| {
            let cleaned = arg.trim_matches('"');
            let p = Path::new(cleaned);
            if !p.exists() {
                return None;
            }
            if p.is_dir() {
                return Some(cleaned.to_string());
            }
            let ext = path_ext_lower(p);
            if is_ext_in(&ext, AUDIO_EXTS)
                || is_ext_in(&ext, VIDEO_EXTS)
                || is_ext_in(&ext, PLAYLIST_EXTS)
            {
                Some(cleaned.to_string())
            } else {
                None
            }
        })
        .collect()
}

fn canonical_entry_key(path: &Path) -> String {
    let mut s = path.to_string_lossy().replace('\\', "/");
    if let Some(rest) = s.strip_prefix("//?/UNC/") {
        s = format!("//{rest}");
    } else if let Some(rest) = s.strip_prefix("//?/") {
        s = rest.to_string();
    }
    format!("fs:{}", s.to_lowercase())
}

fn decode_file_uri_to_path(raw: &str) -> String {
    let trimmed = raw.trim();
    if !trimmed.to_ascii_lowercase().starts_with("file://") {
        return trimmed.to_string();
    }
    let after = &trimmed[7..];
    let after_host = if after.to_ascii_lowercase().starts_with("localhost/") {
        &after["localhost".len()..]
    } else {
        after
    };
    if after_host.starts_with('/') {
        let decoded = percent_decode_str(after_host)
            .decode_utf8_lossy()
            .into_owned();
        #[cfg(target_os = "windows")]
        {
            let trimmed_slash = if decoded.len() >= 3
                && decoded.as_bytes()[0] == b'/'
                && decoded.as_bytes()[1].is_ascii_alphabetic()
                && decoded.as_bytes()[2] == b':'
            {
                &decoded[1..]
            } else {
                decoded.as_str()
            };
            return trimmed_slash.replace('/', "\\");
        }
        #[cfg(not(target_os = "windows"))]
        {
            return decoded;
        }
    }
    // UNC path: file://server/share/dir/clip.mp4
    if let Some((host, rest)) = after_host.split_once('/') {
        let decoded_rest = percent_decode_str(rest).decode_utf8_lossy().into_owned();
        #[cfg(target_os = "windows")]
        {
            return format!("\\\\{host}\\{}", decoded_rest.replace('/', "\\"));
        }
        #[cfg(not(target_os = "windows"))]
        {
            return format!("//{host}/{decoded_rest}");
        }
    }
    percent_decode_str(after_host)
        .decode_utf8_lossy()
        .into_owned()
}

fn inspect_path_list(paths: Vec<String>) -> InspectResult {
    let mut entries = Vec::new();
    let mut playlists = Vec::new();

    for raw in paths {
        let p_str = decode_file_uri_to_path(&raw);
        let path = PathBuf::from(&p_str);
        if !path.exists() {
            continue;
        }

        if path.is_dir() {
            let mut dir_entries = Vec::new();
            scan_local_directory(&path, "", &mut dir_entries);
            let folder_name = path
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| p_str.clone());
            return InspectResult {
                is_directory: true,
                folder_path: Some(p_str),
                folder_name: Some(folder_name),
                entries: dir_entries,
                playlists: Vec::new(),
            };
        }

        if path.is_file() {
            let name = path
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            let ext = path_ext_lower(&path);
            if is_ext_in(&ext, PLAYLIST_EXTS) {
                let within_limit = fs::metadata(&path)
                    .map(|m| m.is_file() && m.len() <= MAX_TEXT_FILE_BYTES)
                    .unwrap_or(false);
                if within_limit {
                    if let Ok(bytes) = fs::read(&path) {
                        playlists.push(PlaylistEntry {
                            name,
                            full_path: p_str,
                            content: decode_text_smart(&bytes),
                        });
                    }
                }
                continue;
            }
            let kind = if is_ext_in(&ext, VIDEO_EXTS) {
                "video"
            } else if is_ext_in(&ext, AUDIO_EXTS) {
                "audio"
            } else if is_ext_in(&ext, SUBTITLE_EXTS) {
                "subtitle"
            } else {
                continue;
            };
            let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            let mtime_ms = file_mtime_ms(&path);
            let folder_path = path
                .parent()
                .and_then(|p| p.file_name())
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            entries.push(MediaEntry {
                key: canonical_entry_key(&path),
                name,
                folder_path,
                full_path: p_str,
                file_url: build_media_url(&path),
                kind: kind.to_string(),
                ext: ext.to_ascii_uppercase(),
                size,
                mtime_ms,
            });
        }
    }

    InspectResult {
        is_directory: false,
        folder_path: None,
        folder_name: None,
        entries,
        playlists,
    }
}

fn strip_extension(name: &str) -> &str {
    match name.rfind('.') {
        Some(idx) if idx > 0 => &name[..idx],
        _ => name,
    }
}

fn normalize_media_name(raw: &str) -> String {
    let base = strip_extension(raw).to_lowercase();
    let replaced: String = base
        .chars()
        .map(|c| match c {
            '.' | '_' | '-' | '[' | ']' | '(' | ')' | '{' | '}' | '+' => ' ',
            _ => c,
        })
        .collect();
    let tokens: Vec<&str> = replaced.split_whitespace().collect();
    let lang_suffixes = [
        "ar", "ara", "arabic", "en", "eng", "english", "sdh", "hi", "forced", "cc", "sub", "subs",
        "default",
    ];
    let mut end = tokens.len();
    while end > 1 && lang_suffixes.contains(&tokens[end - 1]) {
        end -= 1;
    }
    tokens[..end].join(" ")
}

fn extract_core_tokens(norm: &str) -> Vec<String> {
    norm.split_whitespace()
        .filter(|tok| tok.chars().count() > 1 && !SUB_NOISE_TOKENS.contains(tok))
        .map(|s| s.to_string())
        .collect()
}

fn extract_episode_tag(norm: &str) -> Option<String> {
    let tokens: Vec<&str> = norm.split_whitespace().collect();
    for tok in &tokens {
        let bytes = tok.as_bytes();
        // Match s01e02 pattern
        if bytes.len() >= 4 && bytes[0] == b's' {
            if let Some(e_pos) = tok[1..].find('e') {
                let s_part = &tok[1..1 + e_pos];
                let e_part = &tok[2 + e_pos..];
                if !s_part.is_empty()
                    && !e_part.is_empty()
                    && s_part.chars().all(|c| c.is_ascii_digit())
                    && e_part.chars().all(|c| c.is_ascii_digit())
                {
                    return Some(tok.to_string());
                }
            }
        }
        // Match 1x02 pattern
        if let Some(x_pos) = tok.find('x') {
            let left = &tok[..x_pos];
            let right = &tok[x_pos + 1..];
            if !left.is_empty()
                && !right.is_empty()
                && left.len() <= 2
                && right.len() <= 3
                && left.chars().all(|c| c.is_ascii_digit())
                && right.chars().all(|c| c.is_ascii_digit())
            {
                return Some(tok.to_string());
            }
        }
    }
    None
}

fn has_arabic_hint(name: &str) -> bool {
    let lower = strip_extension(name).to_lowercase();
    if lower.contains("عربي") || lower.contains("عربية") || lower.contains("ترجمة") {
        return true;
    }
    let replaced: String = lower
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect();
    replaced
        .split_whitespace()
        .any(|tok| matches!(tok, "ar" | "ara" | "arabic"))
}

fn has_english_hint(name: &str) -> bool {
    let lower = strip_extension(name).to_lowercase();
    let replaced: String = lower
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect();
    replaced
        .split_whitespace()
        .any(|tok| matches!(tok, "en" | "eng" | "english"))
}

fn resolve_target_sub_lang(
    preferred_lang: Option<&str>,
    ui_lang: Option<&str>,
) -> (&'static str, bool) {
    match preferred_lang.map(str::trim) {
        Some(p) if p.eq_ignore_ascii_case("ar") => ("ar", true),
        Some(p) if p.eq_ignore_ascii_case("en") => ("en", true),
        _ => {
            if ui_lang
                .map(|u| u.trim().eq_ignore_ascii_case("ar"))
                .unwrap_or(false)
            {
                ("ar", false)
            } else {
                ("en", false)
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn score_subtitle_candidate(
    video_name: &str,
    sub_name: &str,
    distance_penalty: i32,
    is_only_video: bool,
    sub_count_in_dir: usize,
    preferred_lang: Option<&str>,
    ui_lang: Option<&str>,
) -> i32 {
    let v_raw = strip_extension(video_name).to_lowercase();
    let s_raw = strip_extension(sub_name).to_lowercase();
    let v_norm = normalize_media_name(video_name);
    let s_norm = normalize_media_name(sub_name);

    // Hard episode-mismatch guard: never match a different episode regardless of language tag
    let v_ep = extract_episode_tag(&v_norm);
    let s_ep = extract_episode_tag(&s_norm);
    if let (Some(ve), Some(se)) = (&v_ep, &s_ep) {
        if ve != se {
            return 0;
        }
    }

    let mut score: i32 = 0;

    if v_raw == s_raw {
        score = 1000;
    } else if !v_norm.is_empty() && v_norm == s_norm {
        score = 960;
    } else if !v_norm.is_empty()
        && !s_norm.is_empty()
        && (s_norm.starts_with(&v_norm) || v_norm.starts_with(&s_norm))
        && v_norm.chars().count().min(s_norm.chars().count()) >= 4
    {
        score = 840;
    } else if !v_norm.is_empty()
        && !s_norm.is_empty()
        && (v_norm.contains(&s_norm) || s_norm.contains(&v_norm))
        && v_norm.chars().count().min(s_norm.chars().count()) >= 5
    {
        score = 780;
    } else {
        let v_set: HashSet<String> = extract_core_tokens(&v_norm).into_iter().collect();
        let s_set: HashSet<String> = extract_core_tokens(&s_norm).into_iter().collect();
        let overlap = s_set.iter().filter(|tok| v_set.contains(*tok)).count();

        if let (Some(ve), Some(se)) = (&v_ep, &s_ep) {
            if ve == se {
                score = if overlap > 0 {
                    790 + (overlap as i32 * 15).min(60)
                } else {
                    700
                };
            }
        } else if !v_set.is_empty() && !s_set.is_empty() && overlap > 0 {
            let ratio = (2.0 * overlap as f64) / ((v_set.len() + s_set.len()) as f64);
            let min_len = v_set.len().min(s_set.len()) as f64;
            if ratio >= 0.48 || (overlap >= 2 && (overlap as f64 / min_len) >= 0.65) {
                score = (520.0 + ratio * 240.0).round() as i32;
            }
        }
    }

    if score == 0 && is_only_video && distance_penalty <= 40 && sub_count_in_dir <= 4 {
        score = 420;
    }

    if score == 0 {
        return 0;
    }

    let (target_lang, is_explicit) = resolve_target_sub_lang(preferred_lang, ui_lang);
    let sub_lang = if has_arabic_hint(sub_name) {
        Some("ar")
    } else if has_english_hint(sub_name) {
        Some("en")
    } else {
        None
    };

    if let Some(lang) = sub_lang {
        if lang == target_lang {
            score += if is_explicit { 65 } else { 45 };
        } else {
            score -= if is_explicit { 20 } else { 10 };
        }
    }

    (score - distance_penalty).max(1)
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PreReleaseId {
    Numeric(u64),
    AlphaNumeric(String),
}

impl Ord for PreReleaseId {
    fn cmp(&self, other: &Self) -> CmpOrdering {
        match (self, other) {
            (PreReleaseId::Numeric(a), PreReleaseId::Numeric(b)) => a.cmp(b),
            (PreReleaseId::Numeric(_), PreReleaseId::AlphaNumeric(_)) => CmpOrdering::Less,
            (PreReleaseId::AlphaNumeric(_), PreReleaseId::Numeric(_)) => CmpOrdering::Greater,
            (PreReleaseId::AlphaNumeric(a), PreReleaseId::AlphaNumeric(b)) => a.cmp(b),
        }
    }
}

impl PartialOrd for PreReleaseId {
    fn partial_cmp(&self, other: &Self) -> Option<CmpOrdering> {
        Some(self.cmp(other))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SemVer {
    major: u32,
    minor: u32,
    patch: u32,
    pre: Vec<PreReleaseId>,
}

impl Ord for SemVer {
    fn cmp(&self, other: &Self) -> CmpOrdering {
        (self.major, self.minor, self.patch)
            .cmp(&(other.major, other.minor, other.patch))
            .then_with(|| match (self.pre.is_empty(), other.pre.is_empty()) {
                (true, true) => CmpOrdering::Equal,
                (true, false) => CmpOrdering::Greater,
                (false, true) => CmpOrdering::Less,
                (false, false) => self.pre.cmp(&other.pre),
            })
    }
}

impl PartialOrd for SemVer {
    fn partial_cmp(&self, other: &Self) -> Option<CmpOrdering> {
        Some(self.cmp(other))
    }
}

fn parse_semver(ver: &str) -> SemVer {
    let cleaned = ver.trim().trim_start_matches('v').trim_start_matches('V');
    // Ignore SemVer build metadata (+...) when comparing precedence
    let without_build = cleaned.split('+').next().unwrap_or("");
    let (core, pre_str) = match without_build.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (without_build, None),
    };
    let parts: Vec<u32> = core
        .split('.')
        .map(|p| p.trim().parse::<u32>().unwrap_or(0))
        .collect();
    let pre = pre_str
        .map(|p| {
            p.split('.')
                .filter(|id| !id.is_empty())
                .map(|id| {
                    if id.chars().all(|c| c.is_ascii_digit()) {
                        match id.parse::<u64>() {
                            Ok(n) => PreReleaseId::Numeric(n),
                            Err(_) => PreReleaseId::AlphaNumeric(id.to_string()),
                        }
                    } else {
                        PreReleaseId::AlphaNumeric(id.to_string())
                    }
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    SemVer {
        major: parts.first().copied().unwrap_or(0),
        minor: parts.get(1).copied().unwrap_or(0),
        patch: parts.get(2).copied().unwrap_or(0),
        pre,
    }
}

fn get_configured_repo() -> Option<String> {
    let parsed: RepoConfig = serde_json::from_str(REPO_CONFIG_JSON).ok()?;
    let trimmed = parsed.repo.trim();
    if validate_repo_slug(trimmed) {
        Some(trimmed.to_string())
    } else {
        None
    }
}

fn get_configured_updater_pubkey() -> Result<PublicKey, String> {
    let parsed: RepoConfig = serde_json::from_str(REPO_CONFIG_JSON)
        .map_err(|_| "Updater configuration could not be parsed.".to_string())?;
    parse_minisign_public_key(&parsed.updater_public_key)
}

fn handle_aazmedia_protocol(
    app: &AppHandle,
    req: tauri::http::Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    if req.method() == Method::OPTIONS {
        return Response::builder()
            .status(StatusCode::NO_CONTENT)
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, HEAD, OPTIONS")
            .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "Range, Content-Type")
            .body(Vec::new())
            .unwrap_or_else(|_| Response::new(Vec::new()));
    }

    if req.method() != Method::GET && req.method() != Method::HEAD {
        return build_http_response(
            StatusCode::METHOD_NOT_ALLOWED,
            Some("text/plain; charset=utf-8"),
            b"Method not allowed".to_vec(),
        );
    }

    let query = req.uri().query().unwrap_or("");
    let encoded_path = query
        .split('&')
        .find_map(|pair| pair.strip_prefix("path="))
        .unwrap_or("");

    if encoded_path.is_empty() {
        return build_http_response(
            StatusCode::BAD_REQUEST,
            Some("text/plain; charset=utf-8"),
            b"Missing path".to_vec(),
        );
    }

    let file_path_str = percent_decode_str(encoded_path)
        .decode_utf8_lossy()
        .into_owned();

    let state = app.state::<AppState>();
    let canon_path = {
        let auth_files = match state.authorized_files.lock() {
            Ok(g) => g,
            Err(_) => {
                return build_http_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Some("text/plain; charset=utf-8"),
                    b"Authorization state unavailable".to_vec(),
                )
            }
        };
        let auth_dirs = match state.authorized_dirs.lock() {
            Ok(g) => g,
            Err(_) => {
                return build_http_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Some("text/plain; charset=utf-8"),
                    b"Authorization state unavailable".to_vec(),
                )
            }
        };
        match validate_authorized_media_path(&file_path_str, &auth_files, &auth_dirs, false) {
            Ok(p) => p,
            Err(status) => {
                let msg = match status {
                    StatusCode::BAD_REQUEST => b"Invalid path".as_slice(),
                    StatusCode::FORBIDDEN => b"Access denied".as_slice(),
                    _ => b"File not found".as_slice(),
                };
                return build_http_response(
                    status,
                    Some("text/plain; charset=utf-8"),
                    msg.to_vec(),
                );
            }
        }
    };

    let mut file = match File::open(&canon_path) {
        Ok(f) => f,
        Err(_) => {
            return build_http_response(
                StatusCode::NOT_FOUND,
                Some("text/plain; charset=utf-8"),
                b"File not found".to_vec(),
            );
        }
    };

    let file_len = match file.metadata() {
        Ok(m) if m.is_file() => m.len(),
        _ => {
            return build_http_response(
                StatusCode::FORBIDDEN,
                Some("text/plain; charset=utf-8"),
                b"Not a regular file".to_vec(),
            );
        }
    };

    let ext = path_ext_lower(&canon_path);
    let mime = mime_for_ext(&ext);
    let is_head = req.method() == Method::HEAD;

    if file_len == 0 {
        return Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime)
            .header(header::CONTENT_LENGTH, "0")
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header("Cross-Origin-Resource-Policy", "cross-origin")
            .body(Vec::new())
            .unwrap_or_else(|_| Response::new(Vec::new()));
    }

    let max_chunk: u64 = 4 * 1024 * 1024; // 4 MB smooth streaming window

    if let Some(range_val) = req
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
    {
        match parse_http_range(range_val, file_len, Some(max_chunk)) {
            Ok((start, end)) => {
                let len = (end - start + 1) as usize;
                let mut body = Vec::new();
                if !is_head {
                    if file.seek(SeekFrom::Start(start)).is_err() {
                        return build_http_response(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            Some("text/plain; charset=utf-8"),
                            b"Read error".to_vec(),
                        );
                    }
                    body.resize(len, 0);
                    let mut read_total = 0;
                    while read_total < len {
                        match file.read(&mut body[read_total..]) {
                            Ok(0) => break,
                            Ok(n) => read_total += n,
                            Err(_) => break,
                        }
                    }
                    body.truncate(read_total);
                }
                let actual_end = if is_head {
                    end
                } else if body.is_empty() {
                    start
                } else {
                    start + body.len() as u64 - 1
                };
                let content_len = if is_head { len } else { body.len() };

                return Response::builder()
                    .status(StatusCode::PARTIAL_CONTENT)
                    .header(header::CONTENT_TYPE, mime)
                    .header(header::ACCEPT_RANGES, "bytes")
                    .header(
                        header::CONTENT_RANGE,
                        format!("bytes {start}-{actual_end}/{file_len}"),
                    )
                    .header(header::CONTENT_LENGTH, content_len.to_string())
                    .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                    .header("Cross-Origin-Resource-Policy", "cross-origin")
                    .body(body)
                    .unwrap_or_else(|_| Response::new(Vec::new()));
            }
            Err(HttpRangeError::Malformed) => {
                return build_http_response(
                    StatusCode::BAD_REQUEST,
                    Some("text/plain; charset=utf-8"),
                    b"Malformed Range header".to_vec(),
                );
            }
            Err(HttpRangeError::Unsatisfiable) => {
                return Response::builder()
                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                    .header(header::CONTENT_RANGE, format!("bytes */{file_len}"))
                    .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                    .body(Vec::new())
                    .unwrap_or_else(|_| Response::new(Vec::new()));
            }
        }
    }

    // No Range header: stream small files in full, or first chunk as 206 for very large videos
    if file_len > max_chunk * 4 && !is_head {
        let mut body = vec![0u8; max_chunk as usize];
        let mut read_total = 0;
        while read_total < body.len() {
            match file.read(&mut body[read_total..]) {
                Ok(0) => break,
                Ok(n) => read_total += n,
                Err(_) => break,
            }
        }
        body.truncate(read_total);
        let actual_end = if body.is_empty() {
            0
        } else {
            body.len() as u64 - 1
        };
        return Response::builder()
            .status(StatusCode::PARTIAL_CONTENT)
            .header(header::CONTENT_TYPE, mime)
            .header(header::ACCEPT_RANGES, "bytes")
            .header(
                header::CONTENT_RANGE,
                format!("bytes 0-{actual_end}/{file_len}"),
            )
            .header(header::CONTENT_LENGTH, body.len().to_string())
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header("Cross-Origin-Resource-Policy", "cross-origin")
            .body(body)
            .unwrap_or_else(|_| Response::new(Vec::new()));
    }

    let mut body = Vec::new();
    if !is_head && file.read_to_end(&mut body).is_err() {
        return build_http_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            Some("text/plain; charset=utf-8"),
            b"Read error".to_vec(),
        );
    }

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(
            header::CONTENT_LENGTH,
            if is_head { file_len } else { body.len() as u64 }.to_string(),
        )
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header("Cross-Origin-Resource-Policy", "cross-origin")
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

/* ============================================================================
Tauri Commands (Native Rust Backend for AAZ Player)
============================================================================ */

#[tauri::command]
fn aaz_get_app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
fn aaz_get_launch_files(state: State<'_, AppState>) -> Vec<String> {
    let mut guard = state.launch_files.lock().unwrap();
    std::mem::take(&mut *guard)
}

#[tauri::command]
fn aaz_new_window(app: AppHandle) -> Result<bool, String> {
    let id = WINDOW_COUNTER.fetch_add(1, Ordering::SeqCst);
    let label = format!("win_{id}");
    let builder = WebviewWindowBuilder::new(&app, label, WebviewUrl::App("index.html".into()))
        .title("AAZ Player")
        .inner_size(1200.0, 780.0)
        .min_inner_size(460.0, 540.0)
        .resizable(true)
        .decorations(false)
        .shadow(true)
        .background_color(tauri::window::Color(6, 11, 8, 255));

    #[cfg(target_os = "windows")]
    let builder = builder.additional_browser_args("--autoplay-policy=no-user-gesture-required");

    let win = builder.build().map_err(|e| e.to_string())?;
    taskbar::attach_taskbar_controls(&win);
    Ok(true)
}

#[tauri::command]
async fn aaz_select_folder(state: State<'_, AppState>) -> Result<Option<FolderResult>, String> {
    let result = tauri::async_runtime::spawn_blocking(|| {
        let folder = rfd::FileDialog::new()
            .set_title("AAZ Player")
            .pick_folder()?;
        let mut entries = Vec::new();
        scan_local_directory(&folder, "", &mut entries);
        let folder_path = folder.to_string_lossy().into_owned();
        let folder_name = folder
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| folder_path.clone());
        Some(FolderResult {
            folder_path,
            folder_name,
            entries,
        })
    })
    .await
    .ok()
    .flatten();

    if let Some(ref res) = result {
        authorize_dir_path(&state, Path::new(&res.folder_path));
        for entry in &res.entries {
            authorize_file_path(&state, Path::new(&entry.full_path));
        }
    }
    Ok(result)
}

#[tauri::command]
async fn aaz_select_files(state: State<'_, AppState>) -> Result<Option<InspectResult>, String> {
    let result = tauri::async_runtime::spawn_blocking(|| {
        let mut all_exts: Vec<&str> = Vec::new();
        all_exts.extend_from_slice(AUDIO_EXTS);
        all_exts.extend_from_slice(VIDEO_EXTS);
        all_exts.extend_from_slice(SUBTITLE_EXTS);
        all_exts.extend_from_slice(PLAYLIST_EXTS);

        let files = rfd::FileDialog::new()
            .set_title("AAZ Player")
            .add_filter("Media & Playlists", &all_exts)
            .pick_files()?;

        let paths: Vec<String> = files
            .into_iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        Some(inspect_path_list(paths))
    })
    .await
    .ok()
    .flatten();

    if let Some(ref res) = result {
        if let Some(ref fp) = res.folder_path {
            authorize_dir_path(&state, Path::new(fp));
        }
        for entry in &res.entries {
            authorize_file_path(&state, Path::new(&entry.full_path));
        }
        for pl in &res.playlists {
            authorize_file_path(&state, Path::new(&pl.full_path));
        }
    }
    Ok(result)
}

#[tauri::command]
async fn aaz_read_folder(
    state: State<'_, AppState>,
    folder_path: String,
) -> Result<Option<FolderResult>, String> {
    let result = tauri::async_runtime::spawn_blocking(move || {
        let folder = PathBuf::from(&folder_path);
        if !folder.exists() || !folder.is_dir() {
            return None;
        }
        let canon = fs::canonicalize(&folder).ok()?;
        let mut entries = Vec::new();
        scan_local_directory(&canon, "", &mut entries);
        let folder_name = canon
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| folder_path.clone());
        Some(FolderResult {
            folder_path: canon.to_string_lossy().into_owned(),
            folder_name,
            entries,
        })
    })
    .await
    .ok()
    .flatten();

    if let Some(ref res) = result {
        authorize_dir_path(&state, Path::new(&res.folder_path));
        for entry in &res.entries {
            authorize_file_path(&state, Path::new(&entry.full_path));
        }
    }
    Ok(result)
}

#[tauri::command]
async fn aaz_read_text_file(
    state: State<'_, AppState>,
    file_path: String,
) -> Result<Option<String>, String> {
    let canon = match fs::canonicalize(Path::new(file_path.trim())) {
        Ok(p) => p,
        Err(_) => return Ok(None),
    };
    let ext = path_ext_lower(&canon);
    if !canon.is_file() || !is_supported_text_ext(&ext) {
        return Ok(None);
    }
    let allowed = {
        let files = state.authorized_files.lock().map_err(|e| e.to_string())?;
        let dirs = state.authorized_dirs.lock().map_err(|e| e.to_string())?;
        files.contains(&canon) || dirs.iter().any(|d| canon.starts_with(d))
    };
    if !allowed {
        return Ok(None);
    }

    let text = tauri::async_runtime::spawn_blocking(move || {
        let meta = fs::metadata(&canon).ok()?;
        if !meta.is_file() || meta.len() > MAX_TEXT_FILE_BYTES {
            return None;
        }
        let bytes = fs::read(&canon).ok()?;
        Some(decode_text_smart(&bytes))
    })
    .await
    .ok()
    .flatten();
    Ok(text)
}

#[tauri::command]
async fn aaz_find_nearby_subtitle(
    state: State<'_, AppState>,
    video_full_path: String,
    preferred_lang: Option<String>,
    ui_lang: Option<String>,
) -> Result<Option<NearbySubtitle>, String> {
    let canon_video = match fs::canonicalize(Path::new(video_full_path.trim())) {
        Ok(p) if p.is_file() => p,
        _ => return Ok(None),
    };
    let allowed = {
        let files = state.authorized_files.lock().map_err(|e| e.to_string())?;
        let dirs = state.authorized_dirs.lock().map_err(|e| e.to_string())?;
        files.contains(&canon_video) || dirs.iter().any(|d| canon_video.starts_with(d))
    };
    if !allowed {
        return Ok(None);
    }

    let result = tauri::async_runtime::spawn_blocking(move || {
        let video_path = canon_video;
        let video_dir = video_path.parent()?.to_path_buf();
        let video_name = video_path.file_name()?.to_string_lossy().into_owned();
        let v_norm = normalize_media_name(&video_name);
        let v_prefix: String = v_norm.chars().take(10).collect();

        let sub_folder_names: HashSet<&str> = [
            "subs",
            "subtitles",
            "subtitle",
            "sub",
            "arabic",
            "ar",
            "en",
            "cc",
            "captions",
        ]
        .into_iter()
        .collect();

        let mut search_dirs: Vec<(PathBuf, i32)> = vec![(video_dir.clone(), 0)];
        let mut video_count_in_dir = 0usize;

        if let Ok(rd) = fs::read_dir(&video_dir) {
            for ent in rd.flatten() {
                let ft = match ent.file_type() {
                    Ok(t) => t,
                    Err(_) => continue,
                };
                let p = ent.path();
                if ft.is_file() {
                    if is_ext_in(&path_ext_lower(&p), VIDEO_EXTS) {
                        video_count_in_dir += 1;
                    }
                } else if ft.is_dir() {
                    let dir_name = ent.file_name().to_string_lossy().into_owned();
                    let lower = dir_name.to_lowercase();
                    if sub_folder_names.contains(lower.as_str())
                        || lower.contains("sub")
                        || (v_prefix.chars().count() >= 4
                            && normalize_media_name(&dir_name).contains(&v_prefix))
                    {
                        search_dirs.push((p.clone(), 20));
                        if let Ok(nested) = fs::read_dir(&p) {
                            for n_ent in nested.flatten() {
                                if n_ent.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                                    search_dirs.push((n_ent.path(), 30));
                                }
                            }
                        }
                    }
                }
            }
        }

        if let Some(parent_dir) = video_dir.parent() {
            if parent_dir != video_dir {
                search_dirs.push((parent_dir.to_path_buf(), 55));
                for sub_name in ["Subs", "Subtitles", "Subtitle", "Arabic"] {
                    let candidate = parent_dir.join(sub_name);
                    if candidate.is_dir() {
                        search_dirs.push((candidate, 65));
                    }
                }
            }
        }

        let mut best: Option<(i32, String, PathBuf)> = None;
        let mut seen = HashSet::new();

        for (dir, penalty) in search_dirs {
            let rd = match fs::read_dir(&dir) {
                Ok(r) => r,
                Err(_) => continue,
            };
            let sub_files: Vec<(String, PathBuf)> = rd
                .flatten()
                .filter_map(|ent| {
                    if !ent.file_type().map(|t| t.is_file()).unwrap_or(false) {
                        return None;
                    }
                    let p = ent.path();
                    if !is_ext_in(&path_ext_lower(&p), SUBTITLE_EXTS) {
                        return None;
                    }
                    Some((ent.file_name().to_string_lossy().into_owned(), p))
                })
                .collect();

            let count_here = sub_files.len();
            for (name, full_path) in sub_files {
                let canonical = full_path.to_string_lossy().into_owned();
                if !seen.insert(canonical) {
                    continue;
                }
                let score = score_subtitle_candidate(
                    &video_name,
                    &name,
                    penalty,
                    video_count_in_dir <= 1,
                    count_here,
                    preferred_lang.as_deref(),
                    ui_lang.as_deref(),
                );
                if score >= 380 {
                    let replace = match &best {
                        Some((best_score, _, _)) => score > *best_score,
                        None => true,
                    };
                    if replace {
                        best = Some((score, name, full_path));
                    }
                }
            }
        }

        let (score, name, full_path) = best?;
        let meta = fs::metadata(&full_path).ok()?;
        if !meta.is_file() || meta.len() > MAX_TEXT_FILE_BYTES {
            return None;
        }
        let bytes = fs::read(&full_path).ok()?;
        let text = decode_text_smart(&bytes);
        Some(NearbySubtitle {
            name,
            full_path: full_path.to_string_lossy().into_owned(),
            text,
            score,
        })
    })
    .await
    .ok()
    .flatten();

    if let Some(ref sub) = result {
        authorize_file_path(&state, Path::new(&sub.full_path));
    }
    Ok(result)
}

#[tauri::command]
async fn aaz_inspect_paths(
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<InspectResult, String> {
    let result = tauri::async_runtime::spawn_blocking(move || inspect_path_list(paths))
        .await
        .unwrap_or(InspectResult {
            is_directory: false,
            folder_path: None,
            folder_name: None,
            entries: Vec::new(),
            playlists: Vec::new(),
        });

    if let Some(ref fp) = result.folder_path {
        authorize_dir_path(&state, Path::new(fp));
    }
    for entry in &result.entries {
        authorize_file_path(&state, Path::new(&entry.full_path));
    }
    for pl in &result.playlists {
        authorize_file_path(&state, Path::new(&pl.full_path));
    }
    Ok(result)
}

#[tauri::command]
fn aaz_set_always_on_top(window: WebviewWindow, enabled: bool) -> bool {
    let _ = window.set_always_on_top(enabled);
    window.is_always_on_top().unwrap_or(enabled)
}

#[tauri::command]
fn aaz_set_fullscreen(window: WebviewWindow, enabled: bool) -> bool {
    let _ = window.set_fullscreen(enabled);
    window.is_fullscreen().unwrap_or(enabled)
}

#[tauri::command]
fn aaz_is_fullscreen(window: WebviewWindow) -> bool {
    window.is_fullscreen().unwrap_or(false)
}

#[tauri::command]
fn aaz_win_minimize(window: WebviewWindow) -> bool {
    window.minimize().is_ok()
}

#[tauri::command]
fn aaz_win_toggle_maximize(window: WebviewWindow) -> bool {
    let currently_max = window.is_maximized().unwrap_or(false);
    if currently_max {
        let _ = window.unmaximize();
    } else {
        let _ = window.maximize();
    }
    window.is_maximized().unwrap_or(!currently_max)
}

#[tauri::command]
fn aaz_win_is_maximized(window: WebviewWindow) -> bool {
    window.is_maximized().unwrap_or(false)
}

#[tauri::command]
fn aaz_win_close(window: WebviewWindow) -> bool {
    window.close().is_ok()
}

#[tauri::command]
fn aaz_win_start_drag(window: WebviewWindow) -> bool {
    window.start_dragging().is_ok()
}

fn collect_monitor_work_areas(window: &WebviewWindow) -> Vec<MonitorRect> {
    window
        .available_monitors()
        .unwrap_or_default()
        .into_iter()
        .map(|m| {
            let wa = m.work_area();
            MonitorRect {
                x: wa.position.x,
                y: wa.position.y,
                width: wa.size.width,
                height: wa.size.height,
            }
        })
        .collect()
}

#[tauri::command]
fn aaz_get_window_geometry(window: WebviewWindow) -> Option<WindowGeometry> {
    let pos = window.outer_position().ok()?;
    let size = window.inner_size().ok()?;
    let scale_factor = window.scale_factor().unwrap_or(1.0);
    let maximized = window.is_maximized().unwrap_or(false);
    let monitors = collect_monitor_work_areas(&window);

    Some(WindowGeometry {
        x: pos.x,
        y: pos.y,
        width: size.width,
        height: size.height,
        maximized,
        scale_factor,
        monitors,
    })
}

#[tauri::command]
fn aaz_apply_window_geometry(
    window: WebviewWindow,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    maximized: bool,
) -> bool {
    let monitors = collect_monitor_work_areas(&window);
    let scale = window.scale_factor().unwrap_or(1.0).max(0.5);
    let min_w = (460.0 * scale).round() as u32;
    let min_h = (540.0 * scale).round() as u32;

    let (cx, cy, cw, ch) =
        clamp_window_geometry_to_monitors(x, y, width, height, min_w, min_h, &monitors);
    let _ = window.set_size(Size::Physical(PhysicalSize::new(cw, ch)));
    let _ = window.set_position(Position::Physical(PhysicalPosition::new(cx, cy)));
    if maximized {
        let _ = window.maximize();
    } else if window.is_maximized().unwrap_or(false) {
        let _ = window.unmaximize();
    }
    true
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn aaz_set_mini_mode(
    window: WebviewWindow,
    enabled: bool,
    x: Option<i32>,
    y: Option<i32>,
    width: Option<u32>,
    height: Option<u32>,
    always_on_top: Option<bool>,
    maximized: Option<bool>,
) -> bool {
    let monitors = collect_monitor_work_areas(&window);
    let scale = window.scale_factor().unwrap_or(1.0).max(0.5);

    if enabled {
        if window.is_fullscreen().unwrap_or(false) {
            let _ = window.set_fullscreen(false);
        }
        if window.is_maximized().unwrap_or(false) {
            let _ = window.unmaximize();
        }
        let _ = window.set_min_size(Some(Size::Logical(LogicalSize::new(300.0, 160.0))));
        let min_w = (300.0 * scale).round() as u32;
        let min_h = (160.0 * scale).round() as u32;
        let def_w = (480.0 * scale).round() as u32;
        let def_h = (270.0 * scale).round() as u32;
        let margin = (24.0 * scale).round() as u32;
        let target_w = width.unwrap_or(def_w).max(min_w);
        let target_h = height.unwrap_or(def_h).max(min_h);
        let default_x = monitors
            .first()
            .map(|m| m.x + m.width.saturating_sub(target_w + margin) as i32)
            .unwrap_or(60);
        let default_y = monitors
            .first()
            .map(|m| m.y + m.height.saturating_sub(target_h + margin) as i32)
            .unwrap_or(60);
        let (cx, cy, cw, ch) = clamp_window_geometry_to_monitors(
            x.unwrap_or(default_x),
            y.unwrap_or(default_y),
            target_w,
            target_h,
            min_w,
            min_h,
            &monitors,
        );
        let _ = window.set_size(Size::Physical(PhysicalSize::new(cw, ch)));
        let _ = window.set_position(Position::Physical(PhysicalPosition::new(cx, cy)));
        if let Some(pin) = always_on_top {
            let _ = window.set_always_on_top(pin);
        }
    } else {
        let _ = window.set_min_size(Some(Size::Logical(LogicalSize::new(460.0, 540.0))));
        let min_w = (460.0 * scale).round() as u32;
        let min_h = (540.0 * scale).round() as u32;
        if let (Some(rx), Some(ry), Some(rw), Some(rh)) = (x, y, width, height) {
            let (cx, cy, cw, ch) =
                clamp_window_geometry_to_monitors(rx, ry, rw, rh, min_w, min_h, &monitors);
            let _ = window.set_size(Size::Physical(PhysicalSize::new(cw, ch)));
            let _ = window.set_position(Position::Physical(PhysicalPosition::new(cx, cy)));
        }
        if let Some(pin) = always_on_top {
            let _ = window.set_always_on_top(pin);
        }
        if maximized == Some(true) {
            let _ = window.maximize();
        }
    }
    true
}

#[tauri::command]
fn aaz_taskbar_update_state(
    window: WebviewWindow,
    has_media: bool,
    is_playing: bool,
    can_prev: bool,
    can_next: bool,
    lang: String,
) -> bool {
    taskbar::update_taskbar_state(
        &window,
        taskbar::TaskbarMediaState {
            has_media,
            is_playing,
            can_prev,
            can_next,
            is_arabic: lang.eq_ignore_ascii_case("ar"),
        },
    );
    true
}

#[tauri::command]
async fn aaz_save_snapshot(data_base64: String, suggested_name: String) -> SaveSnapshotResult {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = match base64::engine::general_purpose::STANDARD.decode(data_base64.trim()) {
            Ok(b) => b,
            Err(_) => {
                return SaveSnapshotResult {
                    saved: false,
                    path: None,
                }
            }
        };

        let target = rfd::FileDialog::new()
            .set_title("Save Video Snapshot")
            .set_file_name(&suggested_name)
            .add_filter("PNG Image", &["png"])
            .save_file();

        match target {
            Some(dest) => {
                if fs::write(&dest, &bytes).is_ok() {
                    SaveSnapshotResult {
                        saved: true,
                        path: Some(dest.to_string_lossy().into_owned()),
                    }
                } else {
                    SaveSnapshotResult {
                        saved: false,
                        path: None,
                    }
                }
            }
            None => SaveSnapshotResult {
                saved: false,
                path: None,
            },
        }
    })
    .await
    .unwrap_or(SaveSnapshotResult {
        saved: false,
        path: None,
    })
}

#[tauri::command]
async fn aaz_list_system_fonts(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    if let Some(cached) = state.cached_fonts.lock().unwrap().clone() {
        return Ok(cached);
    }

    let fonts = tauri::async_runtime::spawn_blocking(|| {
        let mut set = HashSet::new();

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;

            let ps_script = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Drawing; (New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }";
            let mut cmd = Command::new("powershell.exe");
            cmd.args(["-NoProfile", "-NonInteractive", "-Command", ps_script])
                .creation_flags(CREATE_NO_WINDOW);
            if let Ok(output) = cmd.output() {
                if let Ok(text) = String::from_utf8(output.stdout) {
                    for line in text.lines() {
                        let clean = line.trim();
                        if !clean.is_empty() {
                            set.insert(clean.to_string());
                        }
                    }
                }
            }

            if set.is_empty() {
                let mut reg_cmd = Command::new("reg.exe");
                reg_cmd
                    .args([
                        "query",
                        r"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts",
                    ])
                    .creation_flags(CREATE_NO_WINDOW);
                if let Ok(output) = reg_cmd.output() {
                    let text = String::from_utf8_lossy(&output.stdout);
                    for line in text.lines() {
                        if let Some(idx) = line.find("REG_SZ") {
                            let left = line[..idx].trim();
                            let clean = left
                                .replace("(TrueType)", "")
                                .replace("(OpenType)", "")
                                .replace("(All res)", "")
                                .trim()
                                .to_string();
                            if !clean.is_empty() {
                                set.insert(clean);
                            }
                        }
                    }
                }
            }
        }

        #[cfg(not(target_os = "windows"))]
        {
            if let Ok(output) = Command::new("fc-list").args([":", "family"]).output() {
                let text = String::from_utf8_lossy(&output.stdout);
                for line in text.lines() {
                    for part in line.split(',') {
                        let clean = part.trim();
                        if !clean.is_empty() {
                            set.insert(clean.to_string());
                        }
                    }
                }
            }
        }

        let mut list: Vec<String> = set.into_iter().collect();
        list.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
        list
    })
    .await
    .unwrap_or_default();

    if !fonts.is_empty() {
        *state.cached_fonts.lock().unwrap() = Some(fonts.clone());
    }
    Ok(fonts)
}

fn build_secure_http_agent(connect_secs: u64, read_secs: u64) -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(connect_secs))
        .timeout_read(Duration::from_secs(read_secs))
        .redirects(5)
        .build()
}

fn read_bounded_string(resp: ureq::Response, max_bytes: u64) -> Result<String, String> {
    let mut buf = Vec::new();
    resp.into_reader()
        .take(max_bytes + 1)
        .read_to_end(&mut buf)
        .map_err(|_| "Failed to read HTTP response body.".to_string())?;
    if buf.len() as u64 > max_bytes {
        return Err("HTTP response exceeded maximum allowed size.".to_string());
    }
    String::from_utf8(buf).map_err(|_| "HTTP response was not valid UTF-8.".to_string())
}

fn clear_pending_update_state(state: &AppState) {
    if let Ok(mut g) = state.pending_update_url.lock() {
        *g = None;
    }
    if let Ok(mut g) = state.pending_update_version.lock() {
        *g = None;
    }
    if let Ok(mut g) = state.pending_update_sha256.lock() {
        *g = None;
    }
    if let Ok(mut g) = state.pending_update_signature.lock() {
        *g = None;
    }
}

#[tauri::command]
async fn aaz_check_updates(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    clear_pending_update_state(&state);
    let current_ver = app.package_info().version.to_string();
    let repo = match get_configured_repo() {
        Some(r) => r,
        None => {
            return Ok(serde_json::json!({
                "status": "dev-mode",
                "version": current_ver
            }));
        }
    };

    if let Err(err_msg) = get_configured_updater_pubkey() {
        let _ = app.emit(
            "aaz:update-status",
            serde_json::json!({ "status": "error", "message": err_msg }),
        );
        return Ok(serde_json::json!({ "status": "error", "message": err_msg }));
    }

    let url = format!("https://api.github.com/repos/{repo}/releases/latest");
    let fetch_res = tauri::async_runtime::spawn_blocking(move || {
        let agent = build_secure_http_agent(10, 20);
        let resp = agent
            .get(&url)
            .set("User-Agent", "AAZ-Player-Updater")
            .set("Accept", "application/vnd.github+json")
            .call()
            .map_err(|_| "Could not contact GitHub Releases.".to_string())?;
        let text = read_bounded_string(resp, 512 * 1024)?;
        serde_json::from_str::<serde_json::Value>(&text)
            .map_err(|_| "Invalid release metadata received.".to_string())
    })
    .await
    .map_err(|e| e.to_string())?;

    let release = match fetch_res {
        Ok(v) => v,
        Err(msg) => {
            let _ = app.emit(
                "aaz:update-status",
                serde_json::json!({ "status": "error", "message": msg }),
            );
            return Ok(serde_json::json!({ "status": "error", "message": msg }));
        }
    };

    let tag = release
        .get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let remote_ver = tag
        .trim_start_matches('v')
        .trim_start_matches('V')
        .to_string();

    if parse_semver(&remote_ver) <= parse_semver(&current_ver) {
        let _ = app.emit(
            "aaz:update-status",
            serde_json::json!({ "status": "not-available", "version": current_ver }),
        );
        return Ok(serde_json::json!({ "status": "not-available", "version": current_ver }));
    }

    let assets = release
        .get("assets")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let selected_asset = assets
        .iter()
        .find(|a| {
            a.get("name")
                .and_then(|v| v.as_str())
                .map(|n| {
                    let low = n.to_lowercase();
                    low.ends_with(".exe") && low.contains("setup")
                })
                .unwrap_or(false)
        })
        .or_else(|| {
            assets.iter().find(|a| {
                a.get("name")
                    .and_then(|v| v.as_str())
                    .map(|n| {
                        let low = n.to_lowercase();
                        low.ends_with(".exe") && !low.contains("portable")
                    })
                    .unwrap_or(false)
            })
        });

    let Some(asset) = selected_asset else {
        let _ = app.emit(
            "aaz:update-status",
            serde_json::json!({ "status": "not-available", "version": current_ver }),
        );
        return Ok(serde_json::json!({ "status": "not-available", "version": current_ver }));
    };

    let asset_name = asset
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let dl_url = asset
        .get("browser_download_url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    if let Err(err_msg) = validate_update_download_url(&dl_url, &repo) {
        let _ = app.emit(
            "aaz:update-status",
            serde_json::json!({ "status": "error", "message": err_msg }),
        );
        return Ok(serde_json::json!({ "status": "error", "message": err_msg }));
    }

    // Prefer GitHub native asset digest (`sha256:...`), else companion SHA256SUMS.txt / .sha256 asset
    let mut expected_sha256 = asset
        .get("digest")
        .and_then(|v| v.as_str())
        .and_then(parse_sha256_hex);

    if expected_sha256.is_none() {
        let checksum_asset_url = assets.iter().find_map(|a| {
            let n = a.get("name")?.as_str()?.to_lowercase();
            if n == "sha256sums.txt"
                || n == "checksums.txt"
                || n == format!("{}.sha256", asset_name.to_lowercase())
            {
                let u = a.get("browser_download_url")?.as_str()?;
                if validate_update_download_url(u, &repo).is_ok() {
                    return Some(u.to_string());
                }
            }
            None
        });

        if let Some(sum_url) = checksum_asset_url {
            let asset_name_clone = asset_name.clone();
            let repo_clone = repo.clone();
            if let Ok(Ok(found_hash)) =
                tauri::async_runtime::spawn_blocking(move || -> Result<Option<String>, String> {
                    let agent = build_secure_http_agent(10, 15);
                    let resp = agent
                        .get(&sum_url)
                        .set("User-Agent", "AAZ-Player-Updater")
                        .call()
                        .map_err(|_| "Failed to fetch checksum manifest.".to_string())?;
                    validate_update_download_url(resp.get_url(), &repo_clone)?;
                    let text = read_bounded_string(resp, 64 * 1024)?;
                    Ok(find_checksum_in_sums_text(&text, &asset_name_clone))
                })
                .await
            {
                expected_sha256 = found_hash;
            }
        }
    }

    // Fail closed: refuse any release missing a valid SHA-256 digest
    let Some(verified_expected_sha256) = expected_sha256 else {
        let err_msg =
            "Update refused: release does not include a valid SHA-256 checksum.".to_string();
        let _ = app.emit(
            "aaz:update-status",
            serde_json::json!({ "status": "error", "message": err_msg }),
        );
        return Ok(serde_json::json!({ "status": "error", "message": err_msg }));
    };

    // Fail closed: require a companion Minisign signature asset (.minisig or .sig)
    let sig_asset_url = assets.iter().find_map(|a| {
        let n = a.get("name")?.as_str()?.to_lowercase();
        let lower_asset = asset_name.to_lowercase();
        if n == format!("{lower_asset}.minisig") || n == format!("{lower_asset}.sig") {
            let u = a.get("browser_download_url")?.as_str()?;
            if validate_update_download_url(u, &repo).is_ok() {
                return Some(u.to_string());
            }
        }
        None
    });

    let Some(sig_url) = sig_asset_url else {
        let err_msg =
            "Update refused: release does not include a required cryptographic signature (.minisig)."
                .to_string();
        let _ = app.emit(
            "aaz:update-status",
            serde_json::json!({ "status": "error", "message": err_msg }),
        );
        return Ok(serde_json::json!({ "status": "error", "message": err_msg }));
    };

    let repo_clone = repo.clone();
    let sig_fetch = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let agent = build_secure_http_agent(10, 15);
        let resp = agent
            .get(&sig_url)
            .set("User-Agent", "AAZ-Player-Updater")
            .call()
            .map_err(|_| "Failed to fetch update signature file.".to_string())?;
        validate_update_download_url(resp.get_url(), &repo_clone)?;
        let text = read_bounded_string(resp, 16 * 1024)?;
        Signature::decode(text.trim())
            .map_err(|_| "Update refused: signature file is malformed.".to_string())?;
        Ok(text)
    })
    .await
    .map_err(|e| e.to_string())?;

    let verified_sig_text = match sig_fetch {
        Ok(s) => s,
        Err(err_msg) => {
            let _ = app.emit(
                "aaz:update-status",
                serde_json::json!({ "status": "error", "message": err_msg }),
            );
            return Ok(serde_json::json!({ "status": "error", "message": err_msg }));
        }
    };

    if let Ok(mut g) = state.pending_update_url.lock() {
        *g = Some(dl_url);
    }
    if let Ok(mut g) = state.pending_update_version.lock() {
        *g = Some(remote_ver.clone());
    }
    if let Ok(mut g) = state.pending_update_asset_name.lock() {
        *g = Some(asset_name);
    }
    if let Ok(mut g) = state.pending_update_sha256.lock() {
        *g = Some(verified_expected_sha256);
    }
    if let Ok(mut g) = state.pending_update_signature.lock() {
        *g = Some(verified_sig_text);
    }

    let _ = app.emit(
        "aaz:update-status",
        serde_json::json!({
            "status": "available",
            "version": remote_ver,
            "currentVersion": current_ver
        }),
    );

    Ok(serde_json::json!({ "status": "started" }))
}

struct AtomicFlagGuard<'a>(&'a AtomicBool);

impl Drop for AtomicFlagGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

fn resolve_update_cache_dir(app: &AppHandle) -> PathBuf {
    let base = app
        .path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("aaz-player"));
    let dir = base.join("updates");
    let _ = fs::create_dir_all(&dir);
    dir
}

fn sweep_old_update_installers(dir: &Path) {
    if let Ok(entries) = fs::read_dir(dir) {
        for ent in entries.flatten() {
            let name = ent.file_name().to_string_lossy().into_owned();
            if name.starts_with("AAZ-Player-Setup-") {
                let _ = fs::remove_file(ent.path());
            }
        }
    }
}

#[tauri::command]
async fn aaz_download_update(app: AppHandle, state: State<'_, AppState>) -> Result<bool, String> {
    if state
        .update_downloading
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Ok(false);
    }
    let _dl_guard = AtomicFlagGuard(&state.update_downloading);

    let repo = match get_configured_repo() {
        Some(r) => r,
        None => return Ok(false),
    };
    let pubkey = match get_configured_updater_pubkey() {
        Ok(k) => k,
        Err(err_msg) => {
            let _ = app.emit(
                "aaz:update-status",
                serde_json::json!({ "status": "error", "message": err_msg }),
            );
            return Ok(false);
        }
    };
    let dl_url = state
        .pending_update_url
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let raw_ver = state
        .pending_update_version
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .unwrap_or_else(|| "latest".to_string());
    let asset_name = state
        .pending_update_asset_name
        .lock()
        .map_err(|e| e.to_string())?
        .clone()
        .unwrap_or_default();
    let expected_sha256 = state
        .pending_update_sha256
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    let expected_sig = state
        .pending_update_signature
        .lock()
        .map_err(|e| e.to_string())?
        .clone();

    let Some(url) = dl_url else {
        return Ok(false);
    };

    let Some(sha256_str) = expected_sha256.as_deref().and_then(parse_sha256_hex) else {
        let err_msg =
            "Update refused: missing required SHA-256 checksum before download.".to_string();
        let _ = app.emit(
            "aaz:update-status",
            serde_json::json!({ "status": "error", "message": err_msg }),
        );
        return Ok(false);
    };

    let Some(sig_text) = expected_sig else {
        let err_msg =
            "Update refused: missing required cryptographic signature before download.".to_string();
        let _ = app.emit(
            "aaz:update-status",
            serde_json::json!({ "status": "error", "message": err_msg }),
        );
        return Ok(false);
    };

    if let Err(err_msg) = validate_update_download_url(&url, &repo) {
        let _ = app.emit(
            "aaz:update-status",
            serde_json::json!({ "status": "error", "message": err_msg }),
        );
        return Ok(false);
    }

    let safe_ver = sanitize_version_for_filename(&raw_ver);
    let nonce = generate_session_token()
        .map(|s| s[..12].to_string())
        .unwrap_or_else(|_| "tmp".to_string());
    let updates_dir = resolve_update_cache_dir(&app);
    sweep_old_update_installers(&updates_dir);
    let part_path = updates_dir.join(format!("AAZ-Player-Setup-{safe_ver}-{nonce}.part"));
    let final_path = updates_dir.join(format!("AAZ-Player-Setup-{safe_ver}-{nonce}.exe"));
    let part_clone = part_path.clone();
    let final_clone = final_path.clone();
    let sha_clone = sha256_str.clone();
    let sig_clone = sig_text.clone();
    let ver_clone = raw_ver.clone();
    let asset_clone = asset_name.clone();
    let app_clone = app.clone();

    let result = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let agent = build_secure_http_agent(10, 60);
        let resp = agent
            .get(&url)
            .set("User-Agent", "AAZ-Player-Updater")
            .call()
            .map_err(|_| "Update download failed due to a network error.".to_string())?;

        // Re-validate final redirect destination host
        validate_update_download_url(resp.get_url(), &repo)?;

        let total = resp
            .header("Content-Length")
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);
        if total > MAX_UPDATE_DOWNLOAD_BYTES {
            return Err(
                "Update installer exceeds the maximum permitted download size.".to_string(),
            );
        }

        let mut reader = resp.into_reader();
        let mut out_file = File::create(&part_clone)
            .map_err(|_| "Could not create temporary update file.".to_string())?;
        let mut buf = [0u8; 32768];
        let mut downloaded: u64 = 0;
        let mut last_pct: i32 = -1;

        loop {
            let n = reader
                .read(&mut buf)
                .map_err(|_| "Connection interrupted while downloading update.".to_string())?;
            if n == 0 {
                break;
            }
            downloaded = downloaded.saturating_add(n as u64);
            if downloaded > MAX_UPDATE_DOWNLOAD_BYTES {
                drop(out_file);
                let _ = fs::remove_file(&part_clone);
                return Err("Update download exceeded size limit and was aborted.".to_string());
            }
            if out_file.write_all(&buf[..n]).is_err() {
                drop(out_file);
                let _ = fs::remove_file(&part_clone);
                return Err("Failed writing update file to temporary storage.".to_string());
            }
            if total > 0 {
                let pct = ((downloaded * 100) / total).min(100) as i32;
                if pct != last_pct {
                    last_pct = pct;
                    let _ = app_clone.emit(
                        "aaz:update-status",
                        serde_json::json!({ "status": "downloading", "percent": pct }),
                    );
                }
            }
        }
        out_file
            .flush()
            .map_err(|_| "Failed finalizing downloaded update file.".to_string())?;
        drop(out_file);

        let verified_digest = match verify_file_integrity(
            &part_clone,
            &sha_clone,
            if total > 0 { Some(total) } else { None },
        ) {
            Ok(d) => d,
            Err(err_msg) => {
                let _ = fs::remove_file(&part_clone);
                return Err(err_msg);
            }
        };

        if let Err(err_msg) = verify_file_minisign_with_metadata(
            &part_clone,
            &sig_clone,
            &pubkey,
            &ver_clone,
            &asset_clone,
            &verified_digest,
        ) {
            let _ = fs::remove_file(&part_clone);
            return Err(err_msg);
        }

        let _ = fs::remove_file(&final_clone);
        if fs::rename(&part_clone, &final_clone).is_err() {
            let _ = fs::remove_file(&part_clone);
            return Err("Could not finalize verified installer file.".to_string());
        }

        Ok(verified_digest)
    })
    .await
    .map_err(|e| e.to_string())?;

    match result {
        Ok(verified_digest) => {
            if let Ok(mut g) = state.downloaded_installer.lock() {
                *g = Some(final_path);
            }
            if let Ok(mut g) = state.downloaded_installer_version.lock() {
                *g = Some(raw_ver.clone());
            }
            if let Ok(mut g) = state.downloaded_installer_asset_name.lock() {
                *g = Some(asset_name);
            }
            if let Ok(mut g) = state.downloaded_installer_sha256.lock() {
                *g = Some(verified_digest);
            }
            if let Ok(mut g) = state.downloaded_installer_signature.lock() {
                *g = Some(sig_text);
            }
            let _ = app.emit(
                "aaz:update-status",
                serde_json::json!({ "status": "downloaded", "version": raw_ver }),
            );
            Ok(true)
        }
        Err(msg) => {
            let _ = fs::remove_file(&part_path);
            let _ = app.emit(
                "aaz:update-status",
                serde_json::json!({ "status": "error", "message": msg }),
            );
            Ok(false)
        }
    }
}

#[tauri::command]
fn aaz_install_update(app: AppHandle, state: State<'_, AppState>) -> bool {
    let emit_err = |msg: &str| {
        let _ = app.emit(
            "aaz:update-status",
            serde_json::json!({ "status": "error", "message": msg }),
        );
    };

    let pubkey = match get_configured_updater_pubkey() {
        Ok(k) => k,
        Err(msg) => {
            emit_err(&msg);
            return false;
        }
    };
    let installer = state
        .downloaded_installer
        .lock()
        .ok()
        .and_then(|g| g.clone());
    let expected_ver = state
        .downloaded_installer_version
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or_default();
    let expected_asset = state
        .downloaded_installer_asset_name
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or_default();
    let expected_digest = state
        .downloaded_installer_sha256
        .lock()
        .ok()
        .and_then(|g| g.clone());
    let expected_sig = state
        .downloaded_installer_signature
        .lock()
        .ok()
        .and_then(|g| g.clone());
    let (Some(path), Some(digest), Some(signature)) = (installer, expected_digest, expected_sig)
    else {
        emit_err("No verified installer is ready to launch.");
        return false;
    };

    // Re-verify SHA-256, Minisign signature, and trusted metadata immediately prior to execution
    if let Err(msg) = verify_file_integrity(&path, &digest, None) {
        let _ = fs::remove_file(&path);
        emit_err(&msg);
        return false;
    }
    if let Err(msg) = verify_file_minisign_with_metadata(
        &path,
        &signature,
        &pubkey,
        &expected_ver,
        &expected_asset,
        &digest,
    ) {
        let _ = fs::remove_file(&path);
        emit_err(&msg);
        return false;
    }

    if Command::new(&path).spawn().is_ok() {
        stop_cast_server_for_app(&app);
        app.exit(0);
        true
    } else {
        emit_err("Failed to launch the update installer.");
        false
    }
}

/* ============================================================================
Native LAN Cast Server & UPnP / DLNA Smart TV Casting Engine
============================================================================ */

fn detect_local_lan_ip() -> Result<String, String> {
    // Probe both internet-routed and local private/hotspot gateways so offline LANs work too
    let probes = [
        "1.1.1.1:80",
        "192.168.1.1:80",
        "10.0.0.1:80",
        "172.16.0.1:80",
        "100.64.0.1:80",
    ];
    for target in probes {
        if let Ok(sock) = UdpSocket::bind("0.0.0.0:0") {
            if sock.connect(target).is_ok() {
                if let Ok(addr) = sock.local_addr() {
                    if let std::net::IpAddr::V4(v4) = addr.ip() {
                        if is_allowed_lan_ipv4(v4) {
                            return Ok(v4.to_string());
                        }
                    }
                }
            }
        }
    }
    Err(
        "NO_LAN_IP: No private local network (Wi-Fi/LAN) IPv4 address was detected. Connect to a local Wi-Fi or LAN network to cast."
            .to_string(),
    )
}

fn xml_escape(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn strip_xml_ns(name: &str) -> &str {
    match name.rsplit_once(':') {
        Some((_, local)) => local,
        None => name,
    }
}

fn xml_unescape(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let after = &rest[amp + 1..];
        let Some(semi) = after.find(';') else {
            out.push('&');
            rest = after;
            continue;
        };
        let entity = &after[..semi];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ if entity.starts_with("#x") || entity.starts_with("#X") => {
                u32::from_str_radix(&entity[2..], 16)
                    .ok()
                    .and_then(char::from_u32)
            }
            _ if entity.starts_with('#') => {
                entity[1..].parse::<u32>().ok().and_then(char::from_u32)
            }
            _ => None,
        };
        if let Some(ch) = decoded {
            out.push(ch);
        } else {
            out.push('&');
            out.push_str(entity);
            out.push(';');
        }
        rest = &after[semi + 1..];
    }
    out.push_str(rest);
    out
}

/// Scans an XML document safely on UTF-8 byte boundaries (never indexing `xml` with
/// offsets derived from a lowercased copy) and returns the inner slices of all elements
/// matching `target_local_name` (ASCII case-insensitive, namespace-agnostic).
fn find_xml_element_inners<'a>(xml: &'a str, target_local_name: &str) -> Vec<&'a str> {
    if xml.len() > MAX_DLNA_XML_BYTES as usize || target_local_name.is_empty() {
        return Vec::new();
    }
    let bytes = xml.as_bytes();
    let len = bytes.len();
    let mut results = Vec::new();
    let mut i = 0usize;
    let mut capture_start: Option<usize> = None;
    let mut capture_depth: usize = 0;

    while i < len {
        let Some(rel_lt) = xml[i..].find('<') else {
            break;
        };
        let lt = i + rel_lt;
        let rem = &xml[lt..];

        // Skip XML comments <!-- ... -->
        if rem.starts_with("<!--") {
            if let Some(end) = rem[4..].find("-->") {
                i = lt + 4 + end + 3;
                continue;
            }
            break;
        }
        // Skip CDATA sections <![CDATA[ ... ]]> without interpreting `<` inside
        if rem.starts_with("<![CDATA[") {
            if let Some(end) = rem[9..].find("]]>") {
                i = lt + 9 + end + 3;
                continue;
            }
            break;
        }
        // Skip processing instructions <? ... ?>
        if rem.starts_with("<?") {
            if let Some(end) = rem[2..].find("?>") {
                i = lt + 2 + end + 2;
                continue;
            }
            break;
        }
        // Skip DOCTYPE / declarations <! ... > (never expand external entities)
        if rem.starts_with("<!") {
            if let Some(end) = rem[2..].find('>') {
                i = lt + 2 + end + 1;
                continue;
            }
            break;
        }

        // Find end of tag `>` respecting quoted attribute values
        let mut j = lt + 1;
        let mut quote: u8 = 0;
        while j < len {
            let b = bytes[j];
            if quote != 0 {
                if b == quote {
                    quote = 0;
                }
            } else if b == b'"' || b == b'\'' {
                quote = b;
            } else if b == b'>' {
                break;
            }
            j += 1;
        }
        if j >= len {
            break;
        }

        let tag_body = xml[lt + 1..j].trim();
        let next_pos = j + 1;
        if tag_body.is_empty() {
            i = next_pos;
            continue;
        }

        let is_closing = tag_body.starts_with('/');
        let is_self_closing = !is_closing && tag_body.ends_with('/');
        let name_part = tag_body
            .trim_start_matches('/')
            .split(|c: char| c.is_ascii_whitespace() || c == '/')
            .next()
            .unwrap_or("");
        let local_name = strip_xml_ns(name_part);

        if local_name.eq_ignore_ascii_case(target_local_name) {
            if is_closing {
                if capture_depth > 0 {
                    capture_depth -= 1;
                    if capture_depth == 0 {
                        if let Some(start) = capture_start.take() {
                            results.push(&xml[start..lt]);
                            if results.len() >= 128 {
                                break;
                            }
                        }
                    }
                }
            } else if !is_self_closing {
                if capture_depth == 0 {
                    capture_start = Some(next_pos);
                }
                if capture_depth < 64 {
                    capture_depth += 1;
                }
            }
        }
        i = next_pos;
    }

    results
}

fn extract_xml_text_content(inner: &str) -> String {
    let mut out = String::with_capacity(inner.len());
    let mut i = 0usize;
    let len = inner.len();
    while i < len {
        let rem = &inner[i..];
        if rem.starts_with("<![CDATA[") {
            if let Some(end) = rem[9..].find("]]>") {
                out.push_str(&rem[9..9 + end]);
                i += 9 + end + 3;
                continue;
            }
            break;
        }
        if rem.starts_with("<!--") {
            if let Some(end) = rem[4..].find("-->") {
                i += 4 + end + 3;
                continue;
            }
            break;
        }
        if let Some(rel_lt) = rem.find('<') {
            out.push_str(&xml_unescape(&rem[..rel_lt]));
            i += rel_lt;
            if let Some(rel_gt) = inner[i..].find('>') {
                i += rel_gt + 1;
            } else {
                break;
            }
        } else {
            out.push_str(&xml_unescape(rem));
            break;
        }
    }
    out.trim().to_string()
}

fn extract_xml_tag(xml: &str, tag: &str) -> Option<String> {
    let inner = find_xml_element_inners(xml, tag).into_iter().next()?;
    let text = extract_xml_text_content(inner);
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn normalize_url_path_segments(raw_path: &str) -> String {
    let trailing_slash = raw_path.ends_with('/');
    let mut stack: Vec<&str> = Vec::new();
    for seg in raw_path.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            stack.pop();
        } else {
            stack.push(seg);
        }
    }
    if stack.is_empty() {
        "/".to_string()
    } else if trailing_slash {
        format!("/{}/", stack.join("/"))
    } else {
        format!("/{}", stack.join("/"))
    }
}

fn resolve_upnp_url(base_url: &str, raw_ref: &str) -> Option<String> {
    let r = raw_ref.trim();
    if r.is_empty() {
        return None;
    }
    let lower_r = r.to_ascii_lowercase();
    if lower_r.starts_with("http://") || lower_r.starts_with("https://") {
        return Some(r.to_string());
    }

    let base = base_url.trim();
    let scheme_end = base.find("://")?;
    let scheme = &base[..scheme_end];
    let after_scheme = &base[scheme_end + 3..];
    let (authority, base_path_with_q) = match after_scheme.find('/') {
        Some(idx) => (&after_scheme[..idx], &after_scheme[idx..]),
        None => (after_scheme, "/"),
    };
    if authority.is_empty() {
        return None;
    }
    let origin = format!("{scheme}://{authority}");

    if r.starts_with("//") {
        return Some(format!("{scheme}:{r}"));
    }

    let (ref_path, ref_query) = match r.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (r, None),
    };

    let combined_path = if ref_path.starts_with('/') {
        normalize_url_path_segments(ref_path)
    } else {
        let base_path = base_path_with_q.split(['?', '#']).next().unwrap_or("/");
        let base_dir = match base_path.rfind('/') {
            Some(pos) => &base_path[..=pos],
            None => "/",
        };
        normalize_url_path_segments(&format!("{base_dir}{ref_path}"))
    };

    match ref_query {
        Some(q) => Some(format!("{origin}{combined_path}?{q}")),
        None => Some(format!("{origin}{combined_path}")),
    }
}

fn extract_avtransport_control_url(xml: &str, location: &str) -> Option<String> {
    let url_base = extract_xml_tag(xml, "URLBase").filter(|u| {
        let low = u.to_ascii_lowercase();
        low.starts_with("http://") || low.starts_with("https://")
    });
    let base_url = url_base.as_deref().unwrap_or(location);

    for svc_inner in find_xml_element_inners(xml, "service") {
        let is_avt = extract_xml_tag(svc_inner, "serviceType")
            .map(|st| st.to_ascii_lowercase().contains("avtransport"))
            .unwrap_or(false)
            || extract_xml_tag(svc_inner, "serviceId")
                .map(|sid| sid.to_ascii_lowercase().contains("avtransport"))
                .unwrap_or(false);
        if !is_avt {
            continue;
        }
        if let Some(ctrl) = extract_xml_tag(svc_inner, "controlURL") {
            if let Some(candidate) = resolve_upnp_url(base_url, &ctrl) {
                if let Ok(validated) = validate_lan_http_url(&candidate) {
                    return Some(validated);
                }
            }
        }
    }
    None
}

fn extract_query_param(raw_target: &str, key: &str) -> Option<String> {
    let query = raw_target.split_once('?')?.1;
    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            if k == key {
                return Some(percent_decode_str(v).decode_utf8_lossy().into_owned());
            }
        }
    }
    None
}

fn authorize_cast_request(
    raw_target: &str,
    header_token: Option<&str>,
    expected_token: &str,
) -> bool {
    if expected_token.is_empty() {
        return false;
    }
    if let Some(q_tok) = extract_query_param(raw_target, "token") {
        if constant_time_eq(&q_tok, expected_token) {
            return true;
        }
    }
    if let Some(h_tok) = header_token {
        if constant_time_eq(h_tok.trim(), expected_token) {
            return true;
        }
    }
    false
}

fn build_cast_receiver_html(title: &str, has_sub: bool, token: &str) -> String {
    let safe_title = xml_escape(title);
    let safe_token = xml_escape(token);
    let track_tag = if has_sub {
        format!(
            r#"<track kind="subtitles" srclang="ar" label="Subtitles" src="/sub.vtt?token={safe_token}" default>"#
        )
    } else {
        String::new()
    };
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{safe_title} — AAZ Cast</title>
<style>
  *{{box-sizing:border-box;margin:0;padding:0}}
  html,body{{width:100%;height:100%;background:#040806;color:#edf5ef;font-family:system-ui,-apple-system,Segoe UI,sans-serif;overflow:hidden}}
  .wrap{{position:relative;width:100vw;height:100vh;display:flex;align-items:center;justify-content:center;background:#000}}
  video{{width:100%;height:100%;object-fit:contain;background:#000}}
  .hud{{position:fixed;top:14px;left:16px;right:16px;display:flex;align-items:center;justify-content:space-between;pointer-events:none;z-index:5;transition:opacity .35s}}
  .pill{{background:rgba(10,20,14,.78);border:1px solid rgba(61,196,121,.45);backdrop-filter:blur(8px);padding:7px 14px;border-radius:8px;font-size:14px;font-weight:600;display:inline-flex;align-items:center;gap:8px}}
  .dot{{width:8px;height:8px;border-radius:50%;background:#3dc479}}
  video::cue{{background:rgba(4,10,6,.72);color:#fff;font-size:1.15em;line-height:1.45}}
</style>
</head>
<body>
  <div class="wrap">
    <div class="hud" id="hud"><div class="pill"><span class="dot"></span><span>AAZ Cast — {safe_title}</span></div></div>
    <video id="v" controls autoplay playsinline crossorigin="anonymous" src="/media?token={safe_token}">{track_tag}</video>
  </div>
  <script>
    const hud=document.getElementById('hud');
    let t=setTimeout(()=>hud.style.opacity='0',4000);
    window.addEventListener('mousemove',()=>{{hud.style.opacity='1';clearTimeout(t);t=setTimeout(()=>hud.style.opacity='0',3500);}});
  </script>
</body>
</html>"#
    )
}

struct CastConnectionGuard {
    active: Arc<AtomicUsize>,
}

impl Drop for CastConnectionGuard {
    fn drop(&mut self) {
        self.active.fetch_sub(1, Ordering::SeqCst);
    }
}

fn try_acquire_cast_slot(active: &Arc<AtomicUsize>, limit: usize) -> Option<CastConnectionGuard> {
    let mut current = active.load(Ordering::SeqCst);
    loop {
        if current >= limit {
            return None;
        }
        match active.compare_exchange_weak(current, current + 1, Ordering::SeqCst, Ordering::SeqCst)
        {
            Ok(_) => {
                return Some(CastConnectionGuard {
                    active: active.clone(),
                });
            }
            Err(next) => current = next,
        }
    }
}

fn resolve_allowed_cast_origin(
    origin_header: Option<&str>,
    bound_ip: &str,
    port: u16,
) -> Option<String> {
    let raw = origin_header?.trim();
    if raw.is_empty() || raw.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return None;
    }
    let self_origin = format!("http://{bound_ip}:{port}");
    if raw == self_origin
        || raw == "http://tauri.localhost"
        || raw == "https://tauri.localhost"
        || raw == "tauri://localhost"
    {
        Some(raw.to_string())
    } else {
        None
    }
}

fn format_cors_headers(allowed_origin: Option<&str>) -> String {
    match allowed_origin {
        Some(origin) => format!("Access-Control-Allow-Origin: {origin}\r\nVary: Origin\r\n"),
        None => String::new(),
    }
}

static CAST_STREAM_ID_SEQ: AtomicU64 = AtomicU64::new(1);

struct ActiveStreamGuard {
    id: u64,
    registry: Arc<Mutex<Vec<(u64, TcpStream)>>>,
}

impl ActiveStreamGuard {
    fn register(registry: Arc<Mutex<Vec<(u64, TcpStream)>>>, stream: &TcpStream) -> Self {
        let id = CAST_STREAM_ID_SEQ.fetch_add(1, Ordering::Relaxed);
        if let Ok(cloned) = stream.try_clone() {
            if let Ok(mut list) = registry.lock() {
                list.push((id, cloned));
            }
        }
        Self { id, registry }
    }
}

impl Drop for ActiveStreamGuard {
    fn drop(&mut self) {
        if let Ok(mut list) = self.registry.lock() {
            list.retain(|(entry_id, _)| *entry_id != self.id);
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
enum HttpHeadError {
    Closed,
    Timeout,
    RequestLineTooLong,
    HeadersTooLarge,
    Malformed,
}

fn find_header_terminator(buf: &[u8]) -> Option<usize> {
    if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
        return Some(pos + 4);
    }
    if let Some(pos) = buf.windows(2).position(|w| w == b"\n\n") {
        return Some(pos + 2);
    }
    None
}

/// Strictly bounded HTTP request-head reader (F06).
/// Never allocates beyond `MAX_HTTP_HEADER_BYTES`, rejects oversized request lines before
/// buffering a full line, enforces an absolute header deadline, and rejects premature EOF.
fn read_http_request_head(
    stream: &mut TcpStream,
    timeout: Duration,
) -> Result<Vec<u8>, HttpHeadError> {
    let deadline = Instant::now() + timeout;
    let mut head = Vec::with_capacity(512);
    let mut chunk = [0u8; 512];

    loop {
        let now = Instant::now();
        if now >= deadline {
            return Err(HttpHeadError::Timeout);
        }
        let remaining = deadline.saturating_duration_since(now);
        let _ = stream.set_read_timeout(Some(remaining.min(Duration::from_secs(2))));

        let max_read = (MAX_HTTP_HEADER_BYTES + 1)
            .saturating_sub(head.len())
            .min(chunk.len());
        if max_read == 0 {
            return Err(HttpHeadError::HeadersTooLarge);
        }

        match stream.read(&mut chunk[..max_read]) {
            Ok(0) => {
                if head.is_empty() {
                    return Err(HttpHeadError::Closed);
                }
                return Err(HttpHeadError::Malformed);
            }
            Ok(n) => {
                head.extend_from_slice(&chunk[..n]);
                if let Some(nl_pos) = head.iter().position(|&b| b == b'\n') {
                    if nl_pos + 1 > MAX_HTTP_REQUEST_LINE_BYTES {
                        return Err(HttpHeadError::RequestLineTooLong);
                    }
                } else if head.len() > MAX_HTTP_REQUEST_LINE_BYTES {
                    return Err(HttpHeadError::RequestLineTooLong);
                }

                if let Some(end_idx) = find_header_terminator(&head) {
                    if end_idx > MAX_HTTP_HEADER_BYTES {
                        return Err(HttpHeadError::HeadersTooLarge);
                    }
                    head.truncate(end_idx);
                    return Ok(head);
                }

                if head.len() > MAX_HTTP_HEADER_BYTES {
                    return Err(HttpHeadError::HeadersTooLarge);
                }
            }
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                if Instant::now() >= deadline {
                    return Err(HttpHeadError::Timeout);
                }
            }
            Err(_) => {
                return if head.is_empty() {
                    Err(HttpHeadError::Closed)
                } else {
                    Err(HttpHeadError::Malformed)
                };
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn handle_cast_http_client(
    mut stream: TcpStream,
    bound_ip: String,
    bound_port: u16,
    running: Arc<AtomicBool>,
    active_streams: Arc<Mutex<Vec<(u64, TcpStream)>>>,
    session_token: Arc<Mutex<String>>,
    media_path: Arc<Mutex<Option<PathBuf>>>,
    media_title: Arc<Mutex<String>>,
    subtitle_vtt: Arc<Mutex<Option<String>>>,
) {
    let _stream_guard = ActiveStreamGuard::register(active_streams, &stream);
    let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));

    let head_bytes = match read_http_request_head(
        &mut stream,
        Duration::from_secs(HTTP_HEADER_TIMEOUT_SECS),
    ) {
        Ok(b) => b,
        Err(HttpHeadError::Closed) => return,
        Err(HttpHeadError::Timeout) => {
            let _ = stream.write_all(
                b"HTTP/1.1 408 Request Timeout\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
            return;
        }
        Err(HttpHeadError::RequestLineTooLong) => {
            let _ = stream.write_all(
                b"HTTP/1.1 414 URI Too Long\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
            return;
        }
        Err(HttpHeadError::HeadersTooLarge) => {
            let _ = stream.write_all(
                b"HTTP/1.1 431 Request Header Fields Too Large\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
            return;
        }
        Err(HttpHeadError::Malformed) => {
            let _ = stream.write_all(
                b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
            return;
        }
    };

    let Ok(head_str) = std::str::from_utf8(&head_bytes) else {
        let _ = stream.write_all(
            b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        return;
    };

    let mut lines = head_str.lines();
    let Some(request_line) = lines.next() else {
        let _ = stream.write_all(
            b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        return;
    };

    let mut parts = request_line.split_whitespace();
    let Some(method_raw) = parts.next() else {
        let _ = stream.write_all(
            b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        return;
    };
    let Some(raw_target) = parts.next() else {
        let _ = stream.write_all(
            b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        return;
    };
    let Some(http_ver) = parts.next() else {
        let _ = stream.write_all(
            b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        return;
    };
    if parts.next().is_some() || !http_ver.starts_with("HTTP/1.") || !raw_target.starts_with('/') {
        let _ = stream.write_all(
            b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        return;
    }

    let method = method_raw.to_ascii_uppercase();
    if !matches!(method.as_str(), "GET" | "HEAD" | "OPTIONS") {
        let _ = stream.write_all(
            b"HTTP/1.1 405 Method Not Allowed\r\nAllow: GET, HEAD, OPTIONS\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        return;
    }

    let path_only = raw_target.split('?').next().unwrap_or("/");

    let mut range_header: Option<String> = None;
    let mut header_token: Option<String> = None;
    let mut origin_header: Option<String> = None;
    let mut header_count: usize = 0;

    for raw_line in lines {
        let trimmed = raw_line.trim();
        if trimmed.is_empty() {
            break;
        }
        header_count += 1;
        if header_count > MAX_HTTP_HEADERS {
            let _ = stream.write_all(
                b"HTTP/1.1 431 Request Header Fields Too Large\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
            return;
        }
        if let Some((k, v)) = trimmed.split_once(':') {
            let key = k.trim();
            if key.eq_ignore_ascii_case("range") {
                range_header = Some(v.trim().to_string());
            } else if key.eq_ignore_ascii_case("x-aaz-token") {
                header_token = Some(v.trim().to_string());
            } else if key.eq_ignore_ascii_case("origin") {
                origin_header = Some(v.trim().to_string());
            }
        }
    }

    let allowed_origin =
        resolve_allowed_cast_origin(origin_header.as_deref(), &bound_ip, bound_port);
    let cors_headers = format_cors_headers(allowed_origin.as_deref());

    if method == "OPTIONS" {
        if origin_header.is_some() && allowed_origin.is_none() {
            let _ = stream.write_all(
                b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
            return;
        }
        let resp = format!(
            "HTTP/1.1 204 No Content\r\n{cors_headers}Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\nAccess-Control-Allow-Headers: Range, Content-Type, X-AAZ-Token\r\nConnection: close\r\n\r\n"
        );
        let _ = stream.write_all(resp.as_bytes());
        return;
    }

    if !running.load(Ordering::SeqCst) {
        let _ = stream.write_all(
            b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        return;
    }

    let expected_token = session_token.lock().map(|g| g.clone()).unwrap_or_default();
    if !authorize_cast_request(raw_target, header_token.as_deref(), &expected_token) {
        let _ = stream.write_all(
            b"HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: 27\r\nConnection: close\r\n\r\nInvalid or missing session.",
        );
        return;
    }

    if path_only == "/" || path_only == "/index.html" {
        let title = media_title.lock().map(|g| g.clone()).unwrap_or_default();
        let has_sub = subtitle_vtt.lock().map(|g| g.is_some()).unwrap_or(false);
        let html = build_cast_receiver_html(&title, has_sub, &expected_token);
        let header = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n",
            html.len()
        );
        let _ = stream.write_all(header.as_bytes());
        if method != "HEAD" {
            let _ = stream.write_all(html.as_bytes());
        }
        return;
    }

    if path_only == "/sub.vtt" {
        let sub_opt = subtitle_vtt.lock().ok().and_then(|g| g.clone());
        if let Some(vtt) = sub_opt {
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/vtt; charset=utf-8\r\nContent-Length: {}\r\n{cors_headers}Cache-Control: no-store\r\nConnection: close\r\n\r\n",
                vtt.len()
            );
            let _ = stream.write_all(header.as_bytes());
            if method != "HEAD" {
                let _ = stream.write_all(vtt.as_bytes());
            }
        } else {
            let _ = stream.write_all(
                b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
        }
        return;
    }

    if path_only == "/info" {
        let title = media_title.lock().map(|g| g.clone()).unwrap_or_default();
        let has_sub = subtitle_vtt.lock().map(|g| g.is_some()).unwrap_or(false);
        let json = serde_json::json!({ "title": title, "hasSubtitle": has_sub }).to_string();
        let header = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{cors_headers}Cache-Control: no-store\r\nConnection: close\r\n\r\n",
            json.len()
        );
        let _ = stream.write_all(header.as_bytes());
        if method != "HEAD" {
            let _ = stream.write_all(json.as_bytes());
        }
        return;
    }

    if path_only == "/media" {
        let active_path = match media_path.lock().ok().and_then(|g| g.clone()) {
            Some(p) => p,
            None => {
                let _ = stream.write_all(
                    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                );
                return;
            }
        };
        let mut file = match File::open(&active_path) {
            Ok(f) => f,
            Err(_) => {
                let _ = stream.write_all(
                    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                );
                return;
            }
        };
        let file_len = match file.metadata() {
            Ok(m) if m.is_file() => m.len(),
            _ => {
                let _ = stream.write_all(
                    b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                );
                return;
            }
        };
        let ext = path_ext_lower(&active_path);
        let mime = mime_for_ext(&ext);

        let (status, start, end) = if let Some(ref rng) = range_header {
            match parse_http_range(rng, file_len, None) {
                Ok((s, e)) => ("206 Partial Content", s, e),
                Err(HttpRangeError::Malformed) => {
                    let _ = stream.write_all(
                        b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    );
                    return;
                }
                Err(HttpRangeError::Unsatisfiable) => {
                    let resp = format!(
                        "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{file_len}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    );
                    let _ = stream.write_all(resp.as_bytes());
                    return;
                }
            }
        } else {
            ("200 OK", 0, file_len.saturating_sub(1))
        };

        let content_len = if file_len == 0 { 0 } else { end - start + 1 };
        let range_line = if status.starts_with("206") {
            format!("Content-Range: bytes {start}-{end}/{file_len}\r\n")
        } else {
            String::new()
        };

        let headers = format!(
            "HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nContent-Length: {content_len}\r\n{range_line}Accept-Ranges: bytes\r\n{cors_headers}transferMode.dlna.org: Streaming\r\ncontentFeatures.dlna.org: DLNA.ORG_OP=01;DLNA.ORG_CI=0\r\nConnection: close\r\n\r\n"
        );
        if stream.write_all(headers.as_bytes()).is_err() {
            return;
        }
        if method == "HEAD" || content_len == 0 {
            return;
        }
        if file.seek(SeekFrom::Start(start)).is_err() {
            return;
        }
        let mut remaining = content_len;
        let mut buf = [0u8; 65536];
        while remaining > 0 {
            if !running.load(Ordering::SeqCst) {
                let _ = stream.shutdown(Shutdown::Both);
                break;
            }
            let to_read = (remaining as usize).min(buf.len());
            match file.read(&mut buf[..to_read]) {
                Ok(0) => break,
                Ok(n) => {
                    if !running.load(Ordering::SeqCst) {
                        let _ = stream.shutdown(Shutdown::Both);
                        break;
                    }
                    if stream.write_all(&buf[..n]).is_err() {
                        break;
                    }
                    remaining -= n as u64;
                }
                Err(_) => break,
            }
        }
        return;
    }

    let _ = stream
        .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
}

fn shutdown_active_cast_streams(active_streams: &Arc<Mutex<Vec<(u64, TcpStream)>>>) {
    if let Ok(mut list) = active_streams.lock() {
        for (_, stream) in list.drain(..) {
            let _ = stream.shutdown(Shutdown::Both);
        }
    }
}

fn stop_cast_server_inner(state: &AppState) -> bool {
    if let Ok(mut guard) = state.cast_server.lock() {
        if let Some(srv) = guard.take() {
            srv.running.store(false, Ordering::SeqCst);
            if let Ok(mut p) = srv.media_path.lock() {
                *p = None;
            }
            if let Ok(mut s) = srv.subtitle_vtt.lock() {
                *s = None;
            }
            if let Ok(mut tok) = srv.session_token.lock() {
                tok.clear();
            }
            shutdown_active_cast_streams(&srv.active_streams);
            return true;
        }
    }
    false
}

fn stop_cast_server_for_app(app: &AppHandle) {
    let state = app.state::<AppState>();
    let _ = stop_cast_server_inner(&state);
}

#[tauri::command]
fn aaz_cast_start_server(
    state: State<'_, AppState>,
    media_path: String,
    title: String,
    subtitle_vtt: Option<String>,
) -> Result<CastServerInfo, String> {
    let canon_media = {
        let auth_files = state.authorized_files.lock().map_err(|e| e.to_string())?;
        let auth_dirs = state.authorized_dirs.lock().map_err(|e| e.to_string())?;
        validate_authorized_media_path(&media_path, &auth_files, &auth_dirs, true)
            .map_err(|_| "Media file is not authorized or not supported for casting.".to_string())?
    };

    let mut guard = state.cast_server.lock().map_err(|e| e.to_string())?;
    if let Some(existing) = guard.as_ref() {
        if existing.running.load(Ordering::SeqCst) {
            if let Ok(mut mp) = existing.media_path.lock() {
                *mp = Some(canon_media);
            }
            if let Ok(mut mt) = existing.media_title.lock() {
                *mt = title;
            }
            if let Ok(mut sv) = existing.subtitle_vtt.lock() {
                *sv = subtitle_vtt;
            }
            let tok = existing
                .session_token
                .lock()
                .map(|g| g.clone())
                .unwrap_or_default();
            let base = format!("http://{}:{}", existing.lan_ip, existing.port);
            return Ok(CastServerInfo {
                lan_ip: existing.lan_ip.clone(),
                port: existing.port,
                receiver_url: format!("{base}/?token={tok}"),
                media_url: format!("{base}/media?token={tok}"),
                subtitle_url: format!("{base}/sub.vtt?token={tok}"),
            });
        }
    }

    let bound_ip = detect_local_lan_ip()?;
    let listener = TcpListener::bind(format!("{bound_ip}:0")).map_err(|_| {
        "LAN_BIND_FAILED: Could not bind local streaming server to the detected LAN adapter."
            .to_string()
    })?;
    let port = listener
        .local_addr()
        .map_err(|_| "Could not determine listener port.".to_string())?
        .port();
    let _ = listener.set_nonblocking(true);

    let token = generate_session_token()?;
    let running = Arc::new(AtomicBool::new(true));
    let active_connections = Arc::new(AtomicUsize::new(0));
    let active_streams: Arc<Mutex<Vec<(u64, TcpStream)>>> = Arc::new(Mutex::new(Vec::new()));
    let token_arc = Arc::new(Mutex::new(token.clone()));
    let path_arc = Arc::new(Mutex::new(Some(canon_media)));
    let title_arc = Arc::new(Mutex::new(title));
    let sub_arc = Arc::new(Mutex::new(subtitle_vtt));

    let r_flag = running.clone();
    let streams_clone = active_streams.clone();
    let tok_clone = token_arc.clone();
    let p_clone = path_arc.clone();
    let t_clone = title_arc.clone();
    let s_clone = sub_arc.clone();
    let ip_clone = bound_ip.clone();

    std::thread::spawn(move || {
        while r_flag.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((mut stream, _addr)) => {
                    let _ = stream.set_nonblocking(false);
                    let Some(conn_guard) =
                        try_acquire_cast_slot(&active_connections, MAX_CAST_CONCURRENT_CONNECTIONS)
                    else {
                        let _ = stream.write_all(
                            b"HTTP/1.1 503 Service Unavailable\r\nRetry-After: 2\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                        );
                        continue;
                    };
                    let rf = r_flag.clone();
                    let st = streams_clone.clone();
                    let tk = tok_clone.clone();
                    let mp = p_clone.clone();
                    let mt = t_clone.clone();
                    let sv = s_clone.clone();
                    let ip = ip_clone.clone();
                    std::thread::spawn(move || {
                        let _guard = conn_guard;
                        handle_cast_http_client(stream, ip, port, rf, st, tk, mp, mt, sv);
                    });
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(35));
                }
                Err(_) => break,
            }
        }
    });

    *guard = Some(CastServerState {
        running,
        port,
        lan_ip: bound_ip.clone(),
        session_token: token_arc,
        media_path: path_arc,
        media_title: title_arc,
        subtitle_vtt: sub_arc,
        active_streams,
    });

    let base = format!("http://{bound_ip}:{port}");
    Ok(CastServerInfo {
        lan_ip: bound_ip,
        port,
        receiver_url: format!("{base}/?token={token}"),
        media_url: format!("{base}/media?token={token}"),
        subtitle_url: format!("{base}/sub.vtt?token={token}"),
    })
}

#[tauri::command]
fn aaz_cast_stop_server(state: State<'_, AppState>) -> bool {
    stop_cast_server_inner(&state)
}

#[tauri::command]
async fn aaz_cast_discover_devices(state: State<'_, AppState>) -> Result<Vec<CastDevice>, String> {
    let devices = tauri::async_runtime::spawn_blocking(|| {
        let mut locations = HashSet::new();
        if let Ok(sock) = UdpSocket::bind("0.0.0.0:0") {
            let _ = sock.set_read_timeout(Some(Duration::from_millis(250)));
            let targets = [
                "urn:schemas-upnp-org:service:AVTransport:1",
                "urn:schemas-upnp-org:device:MediaRenderer:1",
            ];
            for st in targets {
                let req = format!(
                    "M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\nST: {st}\r\n\r\n"
                );
                let _ = sock.send_to(req.as_bytes(), "239.255.255.250:1900");
            }
            // MX: 2 requires waiting at least 2000ms plus network response margin (F16)
            let deadline = Instant::now() + Duration::from_millis(2600);
            let mut buf = [0u8; 4096];
            let mut packet_count = 0usize;
            while Instant::now() < deadline
                && packet_count < MAX_SSDP_PACKETS
                && locations.len() < MAX_SSDP_LOCATIONS
            {
                if let Ok((n, _)) = sock.recv_from(&mut buf) {
                    packet_count += 1;
                    let text = String::from_utf8_lossy(&buf[..n]);
                    for line in text.lines() {
                        if let Some((k, v)) = line.split_once(':') {
                            if k.trim().eq_ignore_ascii_case("location") {
                                if let Ok(valid_loc) = validate_lan_http_url(v.trim()) {
                                    locations.insert(valid_loc);
                                }
                            }
                        }
                    }
                }
            }
        }

        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(2))
            .timeout_read(Duration::from_secs(2))
            .redirects(0)
            .build();

        let mut devices = Vec::new();
        for loc in locations {
            let resp = match agent.get(&loc).call() {
                Ok(r) => r,
                Err(_) => continue,
            };
            let xml = match read_bounded_string(resp, MAX_DLNA_XML_BYTES) {
                Ok(s) => s,
                Err(_) => continue,
            };
            let Some(control_url) = extract_avtransport_control_url(&xml, &loc) else {
                continue;
            };
            let name =
                extract_xml_tag(&xml, "friendlyName").unwrap_or_else(|| "Smart TV".to_string());
            let manufacturer = extract_xml_tag(&xml, "manufacturer").unwrap_or_default();
            devices.push(CastDevice {
                id: control_url.clone(),
                name,
                manufacturer,
                control_url,
                location: loc,
            });
        }
        devices.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        devices
    })
    .await
    .unwrap_or_default();

    if let Ok(mut guard) = state.discovered_dlna_controls.lock() {
        guard.clear();
        for dev in &devices {
            guard.insert(dev.control_url.clone());
        }
    }
    Ok(devices)
}

fn send_avtransport_soap(control_url: &str, action: &str, inner_xml: &str) -> Result<(), String> {
    let valid_url = validate_lan_http_url(control_url)?;
    let envelope = format!(
        r#"<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>{inner_xml}</s:Body></s:Envelope>"#
    );
    let soap_action = format!("\"urn:schemas-upnp-org:service:AVTransport:1#{action}\"");
    let agent = ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(2))
        .timeout_read(Duration::from_secs(4))
        .redirects(0)
        .build();
    let resp = agent
        .post(&valid_url)
        .set("Content-Type", "text/xml; charset=\"utf-8\"")
        .set("SOAPAction", &soap_action)
        .send_string(&envelope)
        .map_err(|_| "Could not reach the TV over local Wi-Fi.".to_string())?;
    let _ = read_bounded_string(resp, MAX_DLNA_XML_BYTES);
    Ok(())
}

#[tauri::command]
async fn aaz_cast_to_dlna(
    state: State<'_, AppState>,
    control_url: String,
    media_url: String,
    title: String,
    mime_type: String,
) -> Result<bool, String> {
    let valid_control = validate_lan_http_url(&control_url)?;
    let valid_media = validate_lan_http_url(&media_url)?;
    let known = state
        .discovered_dlna_controls
        .lock()
        .map(|g| g.contains(&valid_control))
        .unwrap_or(false);
    if !known {
        return Err("Target TV was not discovered on the local network.".to_string());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let upnp_class = if mime_type.starts_with("audio/") {
            "object.item.audioItem.musicTrack"
        } else {
            "object.item.videoItem.movie"
        };
        let didl = format!(
            r#"<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="0" parentID="-1" restricted="1"><dc:title>{}</dc:title><upnp:class>{}</upnp:class><res protocolInfo="http-get:*:{}:DLNA.ORG_OP=01;DLNA.ORG_CI=0">{}</res></item></DIDL-Lite>"#,
            xml_escape(&title),
            upnp_class,
            xml_escape(&mime_type),
            xml_escape(&valid_media)
        );
        let set_body = format!(
            r#"<u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID><CurrentURI>{}</CurrentURI><CurrentURIMetaData>{}</CurrentURIMetaData></u:SetAVTransportURI>"#,
            xml_escape(&valid_media),
            xml_escape(&didl)
        );
        send_avtransport_soap(&valid_control, "SetAVTransportURI", &set_body)?;

        let play_body = r#"<u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID><Speed>1</Speed></u:Play>"#;
        send_avtransport_soap(&valid_control, "Play", play_body)?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn aaz_cast_dlna_control(
    state: State<'_, AppState>,
    control_url: String,
    action: String,
    seek_target: Option<String>,
) -> Result<bool, String> {
    let valid_control = validate_lan_http_url(&control_url)?;
    let known = state
        .discovered_dlna_controls
        .lock()
        .map(|g| g.contains(&valid_control))
        .unwrap_or(false);
    if !known {
        return Err("Target TV was not discovered on the local network.".to_string());
    }

    tauri::async_runtime::spawn_blocking(move || {
        match action.as_str() {
            "play" => {
                let body = r#"<u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID><Speed>1</Speed></u:Play>"#;
                send_avtransport_soap(&valid_control, "Play", body)?;
            }
            "pause" => {
                let body = r#"<u:Pause xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:Pause>"#;
                send_avtransport_soap(&valid_control, "Pause", body)?;
            }
            "stop" => {
                let body = r#"<u:Stop xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:Stop>"#;
                send_avtransport_soap(&valid_control, "Stop", body)?;
            }
            "seek" => {
                let target = seek_target.unwrap_or_else(|| "00:00:00".to_string());
                let body = format!(
                    r#"<u:Seek xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID><Unit>REL_TIME</Unit><Target>{}</Target></u:Seek>"#,
                    xml_escape(&target)
                );
                send_avtransport_soap(&valid_control, "Seek", &body)?;
            }
            _ => return Err("Unsupported DLNA control action".to_string()),
        }
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn aaz_cast_open_windows_cast() -> bool {
    #[cfg(target_os = "windows")]
    {
        return Command::new("explorer.exe")
            .arg("ms-settings-connectabledevices:devicediscovery")
            .spawn()
            .is_ok();
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let initial_argv: Vec<String> = std::env::args().collect();
    let initial_files = extract_supported_paths_from_argv(&initial_argv);

    let app_state = AppState::default();
    if !initial_files.is_empty() {
        for raw in &initial_files {
            let p = Path::new(raw);
            if p.is_dir() {
                authorize_dir_path(&app_state, p);
            } else {
                authorize_file_path(&app_state, p);
            }
        }
        if let Ok(mut guard) = app_state.launch_files.lock() {
            *guard = initial_files;
        }
    }

    let app = tauri::Builder::default()
        .manage(app_state)
        .setup(|app| {
            if let Some(win) = app.get_webview_window("main") {
                taskbar::attach_taskbar_controls(&win);
            }
            Ok(())
        })
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let files = extract_supported_paths_from_argv(&argv);
            if !files.is_empty() {
                let state = app.state::<AppState>();
                for raw in &files {
                    let p = Path::new(raw);
                    if p.is_dir() {
                        authorize_dir_path(&state, p);
                    } else {
                        authorize_file_path(&state, p);
                    }
                }
            }
            let target_win = app
                .webview_windows()
                .values()
                .find(|w| w.is_focused().unwrap_or(false))
                .cloned()
                .or_else(|| app.get_webview_window("main"))
                .or_else(|| app.webview_windows().values().next().cloned());

            if let Some(win) = target_win {
                let _ = win.unminimize();
                let _ = win.set_focus();
                if !files.is_empty() {
                    let _ = app.emit_to(win.label(), "aaz:open-external", files);
                }
            } else if !files.is_empty() {
                let state = app.state::<AppState>();
                let Ok(mut queued) = state.launch_files.lock() else {
                    return;
                };
                queued.extend(files);
            }
        }))
        .register_uri_scheme_protocol("aazmedia", |ctx, req| {
            handle_aazmedia_protocol(ctx.app_handle(), req)
        })
        .invoke_handler(tauri::generate_handler![
            aaz_get_app_version,
            aaz_get_launch_files,
            aaz_new_window,
            aaz_select_folder,
            aaz_select_files,
            aaz_read_folder,
            aaz_read_text_file,
            aaz_find_nearby_subtitle,
            aaz_inspect_paths,
            aaz_set_always_on_top,
            aaz_set_fullscreen,
            aaz_is_fullscreen,
            aaz_win_minimize,
            aaz_win_toggle_maximize,
            aaz_win_is_maximized,
            aaz_win_close,
            aaz_win_start_drag,
            aaz_get_window_geometry,
            aaz_apply_window_geometry,
            aaz_set_mini_mode,
            aaz_taskbar_update_state,
            aaz_save_snapshot,
            aaz_list_system_fonts,
            aaz_check_updates,
            aaz_download_update,
            aaz_install_update,
            aaz_cast_start_server,
            aaz_cast_stop_server,
            aaz_cast_discover_devices,
            aaz_cast_to_dlna,
            aaz_cast_dlna_control,
            aaz_cast_open_windows_cast
        ])
        .build(tauri::generate_context!())
        .expect("error while building AAZ Player");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            stop_cast_server_for_app(app_handle);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH as TEST_EPOCH};

    fn make_temp_test_dir(prefix: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(TEST_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("aaz_test_{prefix}_{nanos}"));
        fs::create_dir_all(&dir).expect("create temp test dir");
        dir
    }

    #[test]
    fn media_protocol_rejects_unauthorized_and_non_media_paths() {
        let dir = make_temp_test_dir("media_auth");
        let secret_txt = dir.join("secret.txt");
        let unauth_mp4 = dir.join("unauth.mp4");
        fs::write(&secret_txt, b"private key").unwrap();
        fs::write(&unauth_mp4, b"fake video data").unwrap();

        let auth_files = HashSet::new();
        let mut auth_dirs = HashSet::new();

        // Empty & null byte paths rejected as 400
        assert_eq!(
            validate_authorized_media_path("", &auth_files, &auth_dirs, false),
            Err(StatusCode::BAD_REQUEST)
        );
        assert_eq!(
            validate_authorized_media_path("bad\0path.mp4", &auth_files, &auth_dirs, false),
            Err(StatusCode::BAD_REQUEST)
        );

        // Unauthorized media file rejected as 403
        assert_eq!(
            validate_authorized_media_path(
                unauth_mp4.to_str().unwrap(),
                &auth_files,
                &auth_dirs,
                false
            ),
            Err(StatusCode::FORBIDDEN)
        );

        // Even inside an authorized directory, non-media extensions (.txt) are forbidden
        auth_dirs.insert(fs::canonicalize(&dir).unwrap());
        assert_eq!(
            validate_authorized_media_path(
                secret_txt.to_str().unwrap(),
                &auth_files,
                &auth_dirs,
                false
            ),
            Err(StatusCode::FORBIDDEN)
        );

        // Traversal outside authorized directory is forbidden
        let outside_dir = make_temp_test_dir("outside");
        let outside_mp4 = outside_dir.join("outside.mp4");
        fs::write(&outside_mp4, b"outside").unwrap();
        let traversal = format!(
            "{}/../{}/outside.mp4",
            dir.to_str().unwrap(),
            outside_dir.file_name().unwrap().to_str().unwrap()
        );
        assert_eq!(
            validate_authorized_media_path(&traversal, &auth_files, &auth_dirs, false),
            Err(StatusCode::FORBIDDEN)
        );

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&outside_dir);
    }

    #[test]
    fn media_protocol_allows_authorized_media_and_subtitles() {
        let dir = make_temp_test_dir("media_ok");
        let movie = dir.join("clip.mp4");
        let sub = dir.join("clip.srt");
        fs::write(&movie, b"mp4bytes").unwrap();
        fs::write(&sub, b"1\n00:00:01,000 --> 00:00:02,000\nHi\n").unwrap();

        let mut auth_files = HashSet::new();
        let auth_dirs = HashSet::new();
        let canon_movie = fs::canonicalize(&movie).unwrap();
        let canon_sub = fs::canonicalize(&sub).unwrap();
        auth_files.insert(canon_movie.clone());
        auth_files.insert(canon_sub.clone());

        assert_eq!(
            validate_authorized_media_path(movie.to_str().unwrap(), &auth_files, &auth_dirs, false),
            Ok(canon_movie)
        );
        assert_eq!(
            validate_authorized_media_path(sub.to_str().unwrap(), &auth_files, &auth_dirs, false),
            Ok(canon_sub)
        );
        // Subtitles rejected when audio/video only is required (e.g. Cast media endpoint)
        assert_eq!(
            validate_authorized_media_path(sub.to_str().unwrap(), &auth_files, &auth_dirs, true),
            Err(StatusCode::FORBIDDEN)
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn http_range_parsing_handles_valid_and_invalid_ranges() {
        assert_eq!(parse_http_range("bytes=0-99", 1000, None), Ok((0, 99)));
        assert_eq!(
            parse_http_range("bytes=100-", 1000, Some(200)),
            Ok((100, 299))
        );
        assert_eq!(parse_http_range("bytes=-50", 1000, None), Ok((950, 999)));

        assert_eq!(
            parse_http_range("bytes=abc-def", 1000, None),
            Err(HttpRangeError::Malformed)
        );
        assert_eq!(
            parse_http_range("items=0-10", 1000, None),
            Err(HttpRangeError::Malformed)
        );
        assert_eq!(
            parse_http_range("bytes=1000-1200", 1000, None),
            Err(HttpRangeError::Unsatisfiable)
        );
        assert_eq!(
            parse_http_range("bytes=500-100", 1000, None),
            Err(HttpRangeError::Unsatisfiable)
        );
        assert_eq!(
            parse_http_range("bytes=-0", 1000, None),
            Err(HttpRangeError::Unsatisfiable)
        );
    }

    #[test]
    fn cast_session_token_authorization_enforces_exact_match() {
        let tok = generate_session_token().expect("generate token");
        assert_eq!(tok.len(), 64);

        let valid_target = format!("/media?token={tok}&t=123456");
        assert!(authorize_cast_request(&valid_target, None, &tok));
        assert!(authorize_cast_request("/media", Some(&tok), &tok));
        assert!(!authorize_cast_request("/media", None, &tok));
        assert!(!authorize_cast_request("/media?token=wrong", None, &tok));
        assert!(!authorize_cast_request("/media?token=", Some(""), &tok));
    }

    #[test]
    fn update_url_and_version_validation_blocks_untrusted_sources() {
        let repo = "ahmedzoraa0/aaz-player";
        assert!(validate_update_download_url(
            "https://github.com/ahmedzoraa0/aaz-player/releases/download/v1.5.0/AAZ-Player-Setup-1.5.0.exe",
            repo
        )
        .is_ok());
        assert!(validate_update_download_url(
            "https://objects.githubusercontent.com/github-production-release-asset-123/setup.exe",
            repo
        )
        .is_ok());

        // Plain HTTP, wrong repo, arbitrary host, userinfo, and traversal must fail
        assert!(validate_update_download_url(
            "http://github.com/ahmedzoraa0/aaz-player/releases/download/v1.5.0/setup.exe",
            repo
        )
        .is_err());
        assert!(validate_update_download_url(
            "https://github.com/attacker/evil/releases/download/v1.5.0/setup.exe",
            repo
        )
        .is_err());
        assert!(validate_update_download_url("https://evil.example.com/setup.exe", repo).is_err());
        assert!(validate_update_download_url(
            "https://github.com@evil.com/ahmedzoraa0/aaz-player/releases/download/v1.5.0/s.exe",
            repo
        )
        .is_err());
        assert_eq!(sanitize_version_for_filename("../../evil"), "latest");
        assert_eq!(sanitize_version_for_filename("1.5.0"), "1.5.0");
    }

    #[test]
    fn update_file_integrity_fails_closed_and_detects_hash_mismatch() {
        let dir = make_temp_test_dir("updater");
        let good_exe = dir.join("good.exe");
        let mut payload = vec![b'M', b'Z'];
        payload.extend_from_slice(&[0x90u8; 128]);
        fs::write(&good_exe, &payload).unwrap();

        let expected_digest: String = Sha256::digest(&payload)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();

        // Valid PE + exact SHA-256 passes
        assert_eq!(
            verify_file_integrity(&good_exe, &expected_digest, Some(payload.len() as u64)),
            Ok(expected_digest.clone())
        );

        // Missing / empty / malformed checksum fails closed
        assert!(verify_file_integrity(&good_exe, "", None).is_err());
        assert!(verify_file_integrity(&good_exe, "not-a-sha256", None).is_err());

        // Wrong checksum fails closed
        let bad_hash = "0".repeat(64);
        assert!(verify_file_integrity(&good_exe, &bad_hash, None).is_err());

        // Truncated Content-Length fails
        assert!(verify_file_integrity(&good_exe, &expected_digest, Some(9999)).is_err());

        // Non-PE payload fails even with matching SHA-256
        let bad_file = dir.join("not_pe.exe");
        let non_pe = vec![b'X'; 128];
        fs::write(&bad_file, &non_pe).unwrap();
        let non_pe_hash: String = Sha256::digest(&non_pe)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert!(verify_file_integrity(&bad_file, &non_pe_hash, None).is_err());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn update_minisign_signature_verifies_valid_and_rejects_tampered() {
        let dir = make_temp_test_dir("minisign");
        let target = dir.join("payload.bin");
        fs::write(&target, b"test").unwrap();

        let pubkey =
            parse_minisign_public_key("RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3")
                .expect("valid minisign public key");
        let valid_sig = concat!(
            "untrusted comment: signature from minisign secret key\n",
            "RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/",
            "z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\n",
            "trusted comment: timestamp:1556193335\tfile:test\n",
            "y/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg=="
        );

        assert!(verify_file_minisign(&target, valid_sig, &pubkey).is_ok());

        // Empty or malformed signature fails closed
        assert!(verify_file_minisign(&target, "", &pubkey).is_err());
        assert!(verify_file_minisign(&target, "not a signature", &pubkey).is_err());

        // Empty or invalid public key fails closed
        assert!(parse_minisign_public_key("").is_err());
        assert!(parse_minisign_public_key("invalid-key").is_err());

        // Tampered file fails cryptographic verification
        fs::write(&target, b"tampered").unwrap();
        assert!(verify_file_minisign(&target, valid_sig, &pubkey).is_err());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn dlna_and_lan_ipv4_validation_allows_rfc1918_and_cgnat_only() {
        assert!(is_allowed_lan_ipv4(Ipv4Addr::new(192, 168, 1, 50)));
        assert!(is_allowed_lan_ipv4(Ipv4Addr::new(10, 0, 0, 15)));
        assert!(is_allowed_lan_ipv4(Ipv4Addr::new(172, 16, 5, 20)));
        assert!(is_allowed_lan_ipv4(Ipv4Addr::new(100, 64, 0, 1)));
        assert!(is_allowed_lan_ipv4(Ipv4Addr::new(100, 127, 255, 254)));

        assert!(!is_allowed_lan_ipv4(Ipv4Addr::new(100, 63, 255, 255)));
        assert!(!is_allowed_lan_ipv4(Ipv4Addr::new(100, 128, 0, 1)));
        assert!(!is_allowed_lan_ipv4(Ipv4Addr::new(127, 0, 0, 1)));
        assert!(!is_allowed_lan_ipv4(Ipv4Addr::new(169, 254, 169, 254)));
        assert!(!is_allowed_lan_ipv4(Ipv4Addr::new(8, 8, 8, 8)));

        assert!(
            validate_lan_http_url("http://192.168.1.50:9197/upnp/control/AVTransport1").is_ok()
        );
        assert!(
            validate_lan_http_url("http://10.0.0.15:1400/MediaRenderer/AVTransport/Control")
                .is_ok()
        );
        assert!(validate_lan_http_url("http://172.16.5.20:8080/ctl").is_ok());
        assert!(validate_lan_http_url("http://100.64.10.2:8080/ctl").is_ok());

        // Loopback, link-local metadata, public IPs, DNS hosts, file://, and userinfo blocked
        assert!(validate_lan_http_url("http://127.0.0.1:8080/admin").is_err());
        assert!(validate_lan_http_url("http://169.254.169.254/latest/meta-data/").is_err());
        assert!(validate_lan_http_url("http://8.8.8.8/ctl").is_err());
        assert!(validate_lan_http_url("http://evil.example.com/ctl").is_err());
        assert!(validate_lan_http_url("file:///etc/passwd").is_err());
        assert!(validate_lan_http_url("http://user:pass@192.168.1.50/ctl").is_err());
    }

    #[test]
    fn cast_cors_and_connection_cap_enforce_strict_limits() {
        assert_eq!(
            resolve_allowed_cast_origin(Some("http://192.168.1.10:5555"), "192.168.1.10", 5555),
            Some("http://192.168.1.10:5555".to_string())
        );
        assert_eq!(
            resolve_allowed_cast_origin(Some("http://tauri.localhost"), "192.168.1.10", 5555),
            Some("http://tauri.localhost".to_string())
        );
        assert_eq!(
            resolve_allowed_cast_origin(Some("https://evil.example"), "192.168.1.10", 5555),
            None
        );
        assert_eq!(
            resolve_allowed_cast_origin(Some("http://192.168.1.10:9999"), "192.168.1.10", 5555),
            None
        );
        assert_eq!(
            resolve_allowed_cast_origin(Some("*"), "192.168.1.10", 5555),
            None
        );
        assert_eq!(format_cors_headers(None), "");

        // Connection limiter enforces exact cap and releases on Drop
        let active = Arc::new(AtomicUsize::new(0));
        let g1 = try_acquire_cast_slot(&active, 2).expect("slot 1");
        let g2 = try_acquire_cast_slot(&active, 2).expect("slot 2");
        assert!(try_acquire_cast_slot(&active, 2).is_none());
        drop(g1);
        let g3 = try_acquire_cast_slot(&active, 2).expect("slot freed after drop");
        drop(g2);
        drop(g3);
        assert_eq!(active.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn parse_semver_handles_prerelease_and_build_metadata_precedence() {
        assert!(parse_semver("1.5.0-alpha") < parse_semver("1.5.0-alpha.1"));
        assert!(parse_semver("1.5.0-alpha.1") < parse_semver("1.5.0-alpha.beta"));
        assert!(parse_semver("1.5.0-beta") < parse_semver("1.5.0-beta.2"));
        assert!(parse_semver("1.5.0-beta.2") < parse_semver("1.5.0-beta.11"));
        assert!(parse_semver("1.5.0-beta.11") < parse_semver("1.5.0-rc.1"));
        assert!(parse_semver("1.5.0-rc.1") < parse_semver("1.5.0"));
        assert!(parse_semver("v1.5.0") < parse_semver("v1.5.1-alpha.1"));
        assert_eq!(
            parse_semver("1.5.0+build.123"),
            parse_semver("1.5.0+build.999")
        );
        assert_eq!(parse_semver("v1.5.0-rc.1+abc"), parse_semver("1.5.0-rc.1"));
    }

    #[test]
    fn window_geometry_clamps_safely_within_monitors() {
        let monitors = vec![
            MonitorRect {
                x: 0,
                y: 0,
                width: 1920,
                height: 1080,
            },
            MonitorRect {
                x: 1920,
                y: 0,
                width: 1920,
                height: 1080,
            },
        ];

        // Disconnected 3rd monitor position safely clamped back to primary monitor
        let (x, y, w, h) =
            clamp_window_geometry_to_monitors(5000, -400, 1200, 780, 460, 540, &monitors);
        assert!(x >= 0 && x + w as i32 <= 1920);
        assert!(y >= 0 && y + h as i32 <= 1080);

        // Valid secondary monitor position preserved
        let (x2, y2, w2, h2) =
            clamp_window_geometry_to_monitors(2000, 100, 1000, 700, 460, 540, &monitors);
        assert_eq!((x2, y2, w2, h2), (2000, 100, 1000, 700));
    }

    #[test]
    fn minisign_trusted_comment_blocks_version_file_and_digest_replay() {
        let digest = "a".repeat(64);
        let valid =
            format!("aaz-player|version=1.7.0|file=AAZ-Player_1.7.0_x64-setup.exe|sha256={digest}");
        assert!(validate_minisign_trusted_comment(
            &valid,
            "1.7.0",
            "AAZ-Player_1.7.0_x64-setup.exe",
            &digest
        )
        .is_ok());

        // Version mismatch (downgrade/replay attack) MUST fail
        assert!(validate_minisign_trusted_comment(
            &valid,
            "1.8.0",
            "AAZ-Player_1.7.0_x64-setup.exe",
            &digest
        )
        .is_err());

        // Filename mismatch MUST fail
        assert!(validate_minisign_trusted_comment(
            &valid,
            "1.7.0",
            "AAZ-Player_1.7.0_x64-other.exe",
            &digest
        )
        .is_err());

        // Digest mismatch MUST fail
        let wrong_digest = "b".repeat(64);
        assert!(validate_minisign_trusted_comment(
            &valid,
            "1.7.0",
            "AAZ-Player_1.7.0_x64-setup.exe",
            &wrong_digest
        )
        .is_err());
    }

    #[test]
    fn inspect_path_list_assigns_distinct_canonical_keys_for_same_basename() {
        let root = make_temp_test_dir("f03_keys");
        let dir_a = root.join("FolderA");
        let dir_b = root.join("FolderB");
        fs::create_dir_all(&dir_a).unwrap();
        fs::create_dir_all(&dir_b).unwrap();
        let file_a = dir_a.join("movie.mp4");
        let file_b = dir_b.join("movie.mp4");
        fs::write(&file_a, b"aaaa").unwrap();
        fs::write(&file_b, b"bbbb").unwrap();

        let res = inspect_path_list(vec![
            file_a.to_string_lossy().into_owned(),
            file_b.to_string_lossy().into_owned(),
        ]);
        assert_eq!(res.entries.len(), 2);
        assert_ne!(res.entries[0].key, res.entries[1].key);
        assert_eq!(res.entries[0].folder_path, "FolderA");
        assert_eq!(res.entries[1].folder_path, "FolderB");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn xml_parser_handles_unicode_turkish_i_namespaces_cdata_and_urlbase() {
        // U+0130 ('İ') expands from 2 bytes to 3 bytes when lowercased; must never panic (F05)
        let xml = r#"<?xml version="1.0" encoding="utf-8"?>
<root xmlns="urn:schemas-upnp-org:device-1-0" xmlns:u="urn:schemas-upnp-org:service-1-0">
  <!-- <service><controlURL>/fake</controlURL></service> -->
  <URLBase>http://192.168.1.50:8080/dlna/root/</URLBase>
  <device>
    <friendlyName>İstanbul Salon &amp; TV <![CDATA[<b>4K</b>]]></friendlyName>
    <manufacturer>İzmir Electronics</manufacturer>
    <serviceList>
      <u:service>
        <u:serviceType>urn:schemas-upnp-org:service:AVTransport:1</u:serviceType>
        <u:controlURL>upnp/control/AVTransport</u:controlURL>
      </u:service>
    </serviceList>
  </device>
</root>"#;

        let name = extract_xml_tag(xml, "friendlyName").expect("friendlyName");
        assert_eq!(name, "İstanbul Salon & TV <b>4K</b>");

        let ctrl = extract_avtransport_control_url(xml, "http://192.168.1.50:8080/desc.xml")
            .expect("controlURL with URLBase");
        assert_eq!(
            ctrl,
            "http://192.168.1.50:8080/dlna/root/upnp/control/AVTransport"
        );

        // Without URLBase, relative controlURL resolves against description URL directory (F15)
        let xml_rel = r#"<root><device><serviceList><service>
            <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
            <controlURL>../ctrl/avt</controlURL>
        </service></serviceList></device></root>"#;
        let ctrl_rel =
            extract_avtransport_control_url(xml_rel, "http://192.168.1.50:8080/upnp/desc/dev.xml")
                .expect("relative controlURL");
        assert_eq!(ctrl_rel, "http://192.168.1.50:8080/upnp/ctrl/avt");

        // Public IP in URLBase or controlURL MUST be blocked by LAN SSRF validation
        let xml_ssrf = r#"<root><device><serviceList><service>
            <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
            <controlURL>http://8.8.8.8/evil</controlURL>
        </service></serviceList></device></root>"#;
        assert!(
            extract_avtransport_control_url(xml_ssrf, "http://192.168.1.50:8080/desc.xml")
                .is_none()
        );
    }

    #[test]
    fn http_cast_reader_rejects_oversized_line_headers_and_premature_eof() {
        // 1. Oversized request line -> 414 without reading megabytes (F06)
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let running = Arc::new(AtomicBool::new(true));
        let streams = Arc::new(Mutex::new(Vec::new()));
        let token = Arc::new(Mutex::new("secret".to_string()));
        let media = Arc::new(Mutex::new(None));
        let title = Arc::new(Mutex::new("Test".to_string()));
        let sub = Arc::new(Mutex::new(None));

        let srv_running = running.clone();
        let srv_streams = streams.clone();
        let srv_token = token.clone();
        let srv_media = media.clone();
        let srv_title = title.clone();
        let srv_sub = sub.clone();
        let handle = std::thread::spawn(move || {
            for _ in 0..2 {
                if let Ok((sock, _)) = listener.accept() {
                    handle_cast_http_client(
                        sock,
                        "127.0.0.1".to_string(),
                        addr.port(),
                        srv_running.clone(),
                        srv_streams.clone(),
                        srv_token.clone(),
                        srv_media.clone(),
                        srv_title.clone(),
                        srv_sub.clone(),
                    );
                }
            }
        });

        let mut c1 = TcpStream::connect(addr).unwrap();
        let huge_line = format!("GET /{} HTTP/1.1\r\n\r\n", "a".repeat(5000));
        let _ = c1.write_all(huge_line.as_bytes());
        let mut resp1 = String::new();
        let _ = c1.read_to_string(&mut resp1);
        assert!(resp1.starts_with("HTTP/1.1 414"));

        // 2. Premature EOF before \r\n\r\n -> 400 Bad Request
        let mut c2 = TcpStream::connect(addr).unwrap();
        let _ = c2.write_all(b"GET /info?token=secret HTTP/1.1\r\nHost: localhost");
        let _ = c2.shutdown(Shutdown::Write);
        let mut resp2 = String::new();
        let _ = c2.read_to_string(&mut resp2);
        assert!(resp2.starts_with("HTTP/1.1 400"));

        let _ = handle.join();
    }

    #[test]
    fn cast_stop_immediately_terminates_active_media_stream() {
        let dir = make_temp_test_dir("f07_stop");
        let media_file = dir.join("large.mp4");
        fs::write(&media_file, vec![0x55u8; 4 * 1024 * 1024]).unwrap();

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let running = Arc::new(AtomicBool::new(true));
        let active_streams: Arc<Mutex<Vec<(u64, TcpStream)>>> = Arc::new(Mutex::new(Vec::new()));
        let token = Arc::new(Mutex::new("tok123".to_string()));
        let media_path = Arc::new(Mutex::new(Some(media_file.clone())));
        let title = Arc::new(Mutex::new("Movie".to_string()));
        let sub = Arc::new(Mutex::new(None));

        let srv_r = running.clone();
        let srv_s = active_streams.clone();
        let srv_t = token.clone();
        let srv_m = media_path.clone();
        let srv_title = title.clone();
        let srv_sub = sub.clone();
        let srv_thread = std::thread::spawn(move || {
            if let Ok((sock, _)) = listener.accept() {
                handle_cast_http_client(
                    sock,
                    "127.0.0.1".to_string(),
                    addr.port(),
                    srv_r,
                    srv_s,
                    srv_t,
                    srv_m,
                    srv_title,
                    srv_sub,
                );
            }
        });

        let mut client = TcpStream::connect(addr).unwrap();
        client
            .write_all(b"GET /media?token=tok123 HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            .unwrap();
        // Read just the initial response headers so streaming is actively in flight
        let mut head_chunk = [0u8; 256];
        let _ = client.read(&mut head_chunk);

        // Simulate Stop Cast Server: flip running=false and shut down active sockets (F07)
        running.store(false, Ordering::SeqCst);
        shutdown_active_cast_streams(&active_streams);

        let started = Instant::now();
        let _ = srv_thread.join();
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "active cast stream should terminate promptly on stop"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn subtitle_scoring_honors_preferred_lang_and_blocks_episode_mismatch() {
        let ar_pref_ar = score_subtitle_candidate(
            "Show.S01E01.mp4",
            "Show.S01E01.ar.srt",
            0,
            false,
            2,
            Some("ar"),
            Some("en"),
        );
        let ar_pref_en = score_subtitle_candidate(
            "Show.S01E01.mp4",
            "Show.S01E01.en.srt",
            0,
            false,
            2,
            Some("ar"),
            Some("en"),
        );
        assert!(ar_pref_ar > ar_pref_en);

        let en_pref_en = score_subtitle_candidate(
            "Show.S01E01.mp4",
            "Show.S01E01.en.srt",
            0,
            false,
            2,
            Some("en"),
            Some("ar"),
        );
        let en_pref_ar = score_subtitle_candidate(
            "Show.S01E01.mp4",
            "Show.S01E01.ar.srt",
            0,
            false,
            2,
            Some("en"),
            Some("ar"),
        );
        assert!(en_pref_en > en_pref_ar);

        // Wrong episode must score 0 even with preferred language tag
        let wrong_ep = score_subtitle_candidate(
            "Show.S01E01.mp4",
            "Show.S01E02.ar.srt",
            0,
            true,
            1,
            Some("ar"),
            Some("ar"),
        );
        assert_eq!(wrong_ep, 0);
    }
}
