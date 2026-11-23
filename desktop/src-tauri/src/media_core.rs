//! Platform-neutral HTTP Range parsing and canonical `MediaRef` abstractions (R7, R10).
//!
//! Shared across the desktop `aazmedia://` protocol handler, Android protocol registration,
//! and the token-authenticated LAN cast server. Uses only `std` + `serde`.

use serde::{Deserialize, Serialize};

pub const MAX_HTTP_REQUEST_LINE_BYTES: usize = 2048;
pub const MAX_HTTP_HEADERS: usize = 32;
pub const MAX_HTTP_HEADER_BYTES: usize = 8192;
pub const HTTP_HEADER_TIMEOUT_SECS: u64 = 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HttpRangeError {
    Malformed,
    Unsatisfiable,
}

/// Parses a single HTTP `Range: bytes=...` header value against `file_len` with an optional
/// maximum chunk cap. Strictly rejects malformed syntax, inverted bounds, and out-of-range
/// offsets so both `aazmedia://` and the LAN cast server enforce identical bounds.
pub fn parse_http_range(
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MediaRefKind {
    Path,
    ContentUri,
    MediaStoreUri,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MediaRef {
    pub kind: MediaRefKind,
    pub value: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtime_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_key: Option<String>,
}

impl MediaRef {
    #[allow(dead_code)]
    pub fn from_path(
        value: String,
        display_name: String,
        size: Option<u64>,
        mtime_ms: Option<u64>,
        folder_key: Option<String>,
    ) -> Self {
        Self {
            kind: MediaRefKind::Path,
            value,
            display_name,
            size,
            mtime_ms,
            folder_key,
        }
    }

    #[allow(dead_code)]
    pub fn canonical_key(&self) -> String {
        match self.kind {
            MediaRefKind::Path => {
                let mut s = self.value.trim().to_string();
                if let Some(rest) = s
                    .strip_prefix(r"\\?\UNC\")
                    .or_else(|| s.strip_prefix("//?/UNC/"))
                {
                    s = format!(r"\\{rest}");
                } else if let Some(rest) =
                    s.strip_prefix(r"\\?\").or_else(|| s.strip_prefix("//?/"))
                {
                    s = rest.to_string();
                }
                let is_unc = s.starts_with(r"\\") || s.starts_with("//");
                let mut forward = s.replace('\\', "/");
                while forward.contains("//") {
                    forward = forward.replace("//", "/");
                }
                let restored = if is_unc {
                    format!("//{}", forward.trim_start_matches('/'))
                } else {
                    forward
                };
                format!("fs:{}", restored.trim_end_matches('/').to_lowercase())
            }
            MediaRefKind::ContentUri => format!("uri:{}", self.value.trim()),
            MediaRefKind::MediaStoreUri => format!("ms:{}", self.value.trim()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_ref_canonical_keys_keep_paths_and_content_uris_distinct() {
        let a = MediaRef::from_path(
            r"C:\FolderA\movie.mp4".to_string(),
            "movie.mp4".to_string(),
            Some(1024),
            None,
            None,
        );
        let b = MediaRef::from_path(
            "C:/FolderB/movie.mp4".to_string(),
            "movie.mp4".to_string(),
            Some(1024),
            None,
            None,
        );
        assert_ne!(a.canonical_key(), b.canonical_key());

        let uri = concat!(
            "content://com.android.externalstorage.documents/",
            "document/primary%3AMovies%2Fmovie.mp4"
        );
        let c = MediaRef {
            kind: MediaRefKind::ContentUri,
            value: uri.to_string(),
            display_name: "movie.mp4".to_string(),
            size: Some(1024),
            mtime_ms: None,
            folder_key: None,
        };
        assert!(c.canonical_key().starts_with("uri:content://"));
        assert_ne!(c.canonical_key(), a.canonical_key());
    }
}
