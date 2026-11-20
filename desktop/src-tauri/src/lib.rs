use base64::Engine as _;
use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::http::{header, Method, Response, StatusCode};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const REPO_CONFIG_JSON: &str = include_str!("repo_config.json");

static WINDOW_COUNTER: AtomicU64 = AtomicU64::new(1);

const AUDIO_EXTS: &[&str] = &[
    "mp3", "wav", "flac", "ogg", "oga", "m4a", "aac", "opus", "wma", "aiff", "aif", "aifc",
    "alac", "weba", "mka", "mp2", "amr", "caf", "ac3", "dts", "wv", "ape",
];

const VIDEO_EXTS: &[&str] = &[
    "mp4", "webm", "mkv", "mov", "m4v", "avi", "ogv", "3gp", "3g2", "ts", "mts", "m2ts", "flv",
    "wmv", "mpg", "mpeg",
];

const SUBTITLE_EXTS: &[&str] = &["srt", "vtt"];
const PLAYLIST_EXTS: &[&str] = &["xspf", "m3u8", "m3u", "pls"];

const SUB_NOISE_TOKENS: &[&str] = &[
    "1080p", "720p", "480p", "2160p", "4k", "uhd", "hd", "sd", "hdr", "hdr10", "bluray", "bdrip",
    "brrip", "webrip", "webdl", "web", "dl", "hdtv", "dvdrip", "cam", "ts", "x264", "x265",
    "h264", "h265", "hevc", "avc", "xvid", "10bit", "8bit", "aac", "ac3", "dts", "ddp5", "dd5",
    "atmos", "mp3", "flac", "yts", "yify", "rarbg", "etrg", "evo", "nf", "amzn", "dsnp", "hmax",
    "extended", "unrated", "repack", "proper", "ar", "ara", "arabic", "en", "eng", "english",
    "sub", "subs", "subtitle", "subtitles", "sdh", "hi", "forced", "cc",
];

#[derive(Default)]
struct AppState {
    launch_files: Mutex<Vec<String>>,
    cached_fonts: Mutex<Option<Vec<String>>>,
    pending_update_url: Mutex<Option<String>>,
    pending_update_version: Mutex<Option<String>>,
    downloaded_installer: Mutex<Option<PathBuf>>,
}

#[derive(Deserialize)]
struct RepoConfig {
    repo: String,
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

fn is_ext_in(ext: &str, list: &[&str]) -> bool {
    list.iter().any(|&item| item.eq_ignore_ascii_case(ext))
}

fn path_ext_lower(path: &Path) -> String {
    path.extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default()
}

fn build_media_url(full_path: &Path) -> String {
    let raw = full_path.to_string_lossy();
    let encoded = utf8_percent_encode(raw.as_ref(), NON_ALPHANUMERIC).to_string();
    format!("http://aazmedia.localhost/file?path={encoded}")
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
    let entries = match fs::read_dir(current_dir) {
        Ok(rd) => rd,
        Err(_) => return,
    };

    for entry in entries.flatten() {
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
            scan_local_directory(&full_path, &next_prefix, out);
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

fn inspect_path_list(paths: Vec<String>) -> InspectResult {
    let mut entries = Vec::new();
    let mut playlists = Vec::new();

    for raw in paths {
        let mut p_str = raw.trim().to_string();
        if p_str.starts_with("file://") {
            let stripped = p_str
                .trim_start_matches("file:///")
                .trim_start_matches("file://");
            let decoded = percent_decode_str(stripped).decode_utf8_lossy().into_owned();
            #[cfg(target_os = "windows")]
            {
                p_str = decoded.replace('/', "\\");
            }
            #[cfg(not(target_os = "windows"))]
            {
                p_str = if decoded.starts_with('/') {
                    decoded
                } else {
                    format!("/{decoded}")
                };
            }
        }

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
                if let Ok(bytes) = fs::read(&path) {
                    playlists.push(PlaylistEntry {
                        name,
                        full_path: p_str,
                        content: decode_text_smart(&bytes),
                    });
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
            entries.push(MediaEntry {
                key: name.clone(),
                name,
                folder_path: String::new(),
                full_path: p_str,
                file_url: build_media_url(&path),
                kind: kind.to_string(),
                ext: ext.to_ascii_uppercase(),
                size,
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
    let lower = name.to_lowercase();
    if lower.contains("عربي") || lower.contains("عربية") || lower.contains("ترجمة") {
        return true;
    }
    let replaced: String = lower
        .chars()
        .map(|c| {
            if c.is_alphanumeric() {
                c
            } else {
                ' '
            }
        })
        .collect();
    replaced
        .split_whitespace()
        .any(|tok| matches!(tok, "ar" | "ara" | "arabic"))
}

fn score_subtitle_candidate(
    video_name: &str,
    sub_name: &str,
    distance_penalty: i32,
    is_only_video: bool,
    sub_count_in_dir: usize,
) -> i32 {
    let v_raw = strip_extension(video_name).to_lowercase();
    let s_raw = strip_extension(sub_name).to_lowercase();
    let v_norm = normalize_media_name(video_name);
    let s_norm = normalize_media_name(sub_name);

    let mut score: i32 = 0;

    if v_raw == s_raw {
        score = 1000;
    } else if !v_norm.is_empty() && v_norm == s_norm {
        score = 940;
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
        let v_ep = extract_episode_tag(&v_norm);
        let s_ep = extract_episode_tag(&s_norm);
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
            } else {
                return 0;
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

    if has_arabic_hint(sub_name) {
        score += 28;
    }

    (score - distance_penalty).max(1)
}

fn parse_semver(ver: &str) -> (u32, u32, u32) {
    let cleaned = ver.trim().trim_start_matches('v').trim_start_matches('V');
    let parts: Vec<u32> = cleaned
        .split('.')
        .map(|p| {
            p.chars()
                .take_while(|c| c.is_ascii_digit())
                .collect::<String>()
                .parse::<u32>()
                .unwrap_or(0)
        })
        .collect();
    (
        parts.first().copied().unwrap_or(0),
        parts.get(1).copied().unwrap_or(0),
        parts.get(2).copied().unwrap_or(0),
    )
}

fn get_configured_repo() -> Option<String> {
    let parsed: RepoConfig = serde_json::from_str(REPO_CONFIG_JSON).ok()?;
    let trimmed = parsed.repo.trim();
    if trimmed.contains('/') {
        Some(trimmed.to_string())
    } else {
        None
    }
}

fn handle_aazmedia_protocol(req: tauri::http::Request<Vec<u8>>) -> Response<Vec<u8>> {
    if req.method() == Method::OPTIONS {
        return Response::builder()
            .status(StatusCode::NO_CONTENT)
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, HEAD, OPTIONS")
            .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "Range, Content-Type")
            .body(Vec::new())
            .unwrap();
    }

    let query = req.uri().query().unwrap_or("");
    let encoded_path = query
        .split('&')
        .find_map(|pair| pair.strip_prefix("path="))
        .unwrap_or("");

    if encoded_path.is_empty() {
        return Response::builder()
            .status(StatusCode::BAD_REQUEST)
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .body(b"Missing path".to_vec())
            .unwrap();
    }

    let file_path_str = percent_decode_str(encoded_path)
        .decode_utf8_lossy()
        .into_owned();
    let path = Path::new(&file_path_str);
    let mut file = match File::open(path) {
        Ok(f) => f,
        Err(_) => {
            return Response::builder()
                .status(StatusCode::NOT_FOUND)
                .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                .body(b"File not found".to_vec())
                .unwrap();
        }
    };

    let file_len = match file.metadata() {
        Ok(m) => m.len(),
        Err(_) => 0,
    };

    let ext = path_ext_lower(path);
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
            .unwrap();
    }

    let max_chunk: u64 = 4 * 1024 * 1024; // 4 MB smooth streaming window

    if let Some(range_val) = req.headers().get(header::RANGE).and_then(|v| v.to_str().ok()) {
        if let Some(spec) = range_val.strip_prefix("bytes=") {
            let first_range = spec.split(',').next().unwrap_or("").trim();
            if let Some((start_s, end_s)) = first_range.split_once('-') {
                let (start, end) = if start_s.is_empty() {
                    let suffix: u64 = end_s.parse().unwrap_or(0);
                    let start = file_len.saturating_sub(suffix);
                    (start, file_len - 1)
                } else {
                    let start: u64 = start_s.parse().unwrap_or(0);
                    if start >= file_len {
                        return Response::builder()
                            .status(StatusCode::RANGE_NOT_SATISFIABLE)
                            .header(header::CONTENT_RANGE, format!("bytes */{file_len}"))
                            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                            .body(Vec::new())
                            .unwrap();
                    }
                    let req_end: u64 = if end_s.is_empty() {
                        (start + max_chunk - 1).min(file_len - 1)
                    } else {
                        end_s
                            .parse::<u64>()
                            .unwrap_or(file_len - 1)
                            .min(file_len - 1)
                    };
                    (start, req_end.max(start).min((start + max_chunk - 1).min(file_len - 1)))
                };

                let len = (end - start + 1) as usize;
                let mut body = Vec::new();
                if !is_head {
                    if file.seek(SeekFrom::Start(start)).is_ok() {
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
                    .unwrap();
            }
        }
    }

    // No Range header: stream small files in full, or first chunk as 206 for very large videos
    if file_len > max_chunk * 4 && !is_head {
        let end = max_chunk - 1;
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
        return Response::builder()
            .status(StatusCode::PARTIAL_CONTENT)
            .header(header::CONTENT_TYPE, mime)
            .header(header::ACCEPT_RANGES, "bytes")
            .header(header::CONTENT_RANGE, format!("bytes 0-{end}/{file_len}"))
            .header(header::CONTENT_LENGTH, body.len().to_string())
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header("Cross-Origin-Resource-Policy", "cross-origin")
            .body(body)
            .unwrap();
    }

    let mut body = Vec::new();
    if !is_head {
        let _ = file.read_to_end(&mut body);
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
        .unwrap()
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
        .shadow(true);

    #[cfg(target_os = "windows")]
    let builder = builder.additional_browser_args("--autoplay-policy=no-user-gesture-required");

    builder.build().map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
async fn aaz_select_folder() -> Option<FolderResult> {
    tauri::async_runtime::spawn_blocking(|| {
        let folder = rfd::FileDialog::new().set_title("AAZ Player").pick_folder()?;
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
    .flatten()
}

#[tauri::command]
async fn aaz_select_files() -> Option<InspectResult> {
    tauri::async_runtime::spawn_blocking(|| {
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
    .flatten()
}

#[tauri::command]
async fn aaz_read_folder(folder_path: String) -> Option<FolderResult> {
    tauri::async_runtime::spawn_blocking(move || {
        let folder = PathBuf::from(&folder_path);
        if !folder.exists() || !folder.is_dir() {
            return None;
        }
        let mut entries = Vec::new();
        scan_local_directory(&folder, "", &mut entries);
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
    .flatten()
}

#[tauri::command]
async fn aaz_read_text_file(file_path: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = fs::read(&file_path).ok()?;
        Some(decode_text_smart(&bytes))
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
async fn aaz_find_nearby_subtitle(video_full_path: String) -> Option<NearbySubtitle> {
    tauri::async_runtime::spawn_blocking(move || {
        let video_path = PathBuf::from(&video_full_path);
        if !video_path.exists() {
            return None;
        }
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
    .flatten()
}

#[tauri::command]
async fn aaz_inspect_paths(paths: Vec<String>) -> InspectResult {
    tauri::async_runtime::spawn_blocking(move || inspect_path_list(paths))
        .await
        .unwrap_or(InspectResult {
            is_directory: false,
            folder_path: None,
            folder_name: None,
            entries: Vec::new(),
            playlists: Vec::new(),
        })
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

#[tauri::command]
async fn aaz_check_updates(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
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

    let url = format!("https://api.github.com/repos/{repo}/releases/latest");
    let fetch_res = tauri::async_runtime::spawn_blocking(move || {
        ureq::get(&url)
            .set("User-Agent", "AAZ-Player-Updater")
            .set("Accept", "application/vnd.github+json")
            .call()
            .map_err(|e| e.to_string())
            .and_then(|resp| resp.into_json::<serde_json::Value>().map_err(|e| e.to_string()))
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
    let remote_ver = tag.trim_start_matches('v').trim_start_matches('V').to_string();

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

    let installer_url = assets
        .iter()
        .find_map(|a| {
            let name = a.get("name")?.as_str()?.to_lowercase();
            if name.ends_with(".exe") && name.contains("setup") {
                a.get("browser_download_url")?.as_str().map(|s| s.to_string())
            } else {
                None
            }
        })
        .or_else(|| {
            assets.iter().find_map(|a| {
                let name = a.get("name")?.as_str()?.to_lowercase();
                if name.ends_with(".exe") && !name.contains("portable") {
                    a.get("browser_download_url")?.as_str().map(|s| s.to_string())
                } else {
                    None
                }
            })
        });

    let Some(dl_url) = installer_url else {
        let _ = app.emit(
            "aaz:update-status",
            serde_json::json!({ "status": "not-available", "version": current_ver }),
        );
        return Ok(serde_json::json!({ "status": "not-available", "version": current_ver }));
    };

    *state.pending_update_url.lock().unwrap() = Some(dl_url);
    *state.pending_update_version.lock().unwrap() = Some(remote_ver.clone());

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

#[tauri::command]
async fn aaz_download_update(app: AppHandle, state: State<'_, AppState>) -> Result<bool, String> {
    let dl_url = state.pending_update_url.lock().unwrap().clone();
    let ver = state
        .pending_update_version
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(|| "latest".to_string());

    let Some(url) = dl_url else {
        return Ok(false);
    };

    let app_clone = app.clone();
    let dest_path = std::env::temp_dir().join(format!("AAZ-Player-Setup-{ver}.exe"));
    let dest_clone = dest_path.clone();

    let result = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let resp = ureq::get(&url)
            .set("User-Agent", "AAZ-Player-Updater")
            .call()
            .map_err(|e| e.to_string())?;
        let total = resp
            .header("Content-Length")
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);

        let mut reader = resp.into_reader();
        let mut out_file = File::create(&dest_clone).map_err(|e| e.to_string())?;
        let mut buf = [0u8; 32768];
        let mut downloaded: u64 = 0;
        let mut last_pct: i32 = -1;

        loop {
            let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            out_file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            downloaded += n as u64;
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
        out_file.flush().map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?;

    match result {
        Ok(()) => {
            *state.downloaded_installer.lock().unwrap() = Some(dest_path);
            let _ = app.emit(
                "aaz:update-status",
                serde_json::json!({ "status": "downloaded", "version": ver }),
            );
            Ok(true)
        }
        Err(msg) => {
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
    let installer = state.downloaded_installer.lock().unwrap().clone();
    let Some(path) = installer else {
        return false;
    };
    if Command::new(&path).spawn().is_ok() {
        app.exit(0);
        true
    } else {
        false
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let initial_argv: Vec<String> = std::env::args().collect();
    let initial_files = extract_supported_paths_from_argv(&initial_argv);

    let app_state = AppState::default();
    if !initial_files.is_empty() {
        *app_state.launch_files.lock().unwrap() = initial_files;
    }

    tauri::Builder::default()
        .manage(app_state)
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let files = extract_supported_paths_from_argv(&argv);
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
            if !files.is_empty() {
                let _ = app.emit("aaz:open-external", files);
            }
        }))
        .register_uri_scheme_protocol("aazmedia", |_ctx, req| handle_aazmedia_protocol(req))
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
            aaz_save_snapshot,
            aaz_list_system_fonts,
            aaz_check_updates,
            aaz_download_update,
            aaz_install_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running AAZ Player");
}
