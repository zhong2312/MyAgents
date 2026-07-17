//! Search result types for frontend consumption.

use serde::Serialize;

/// Session search response.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSearchResult {
    pub hits: Vec<SessionSearchHit>,
    pub total_count: usize,
    pub query_time_ms: f64,
}

/// A single session search hit.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSearchHit {
    pub session_id: String,
    pub title: String,
    pub agent_dir: String,
    pub score: f32,
    /// "title" or "content"
    pub match_type: String,
    /// Context snippet for content matches (trimmed with "..." ellipsis)
    pub snippet: Option<String>,
    /// Highlight positions within the snippet: [[start, end], ...]
    pub snippet_highlights: Vec<[usize; 2]>,
    /// Highlight positions within the title: [[start, end], ...]
    pub title_highlights: Vec<[usize; 2]>,
    /// "user" or "assistant" for content matches, None for title matches
    pub matched_role: Option<String>,
    pub last_active_at: String,
    pub source: Option<String>,
    pub turn_count: Option<u32>,
}

/// File search response.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchResult {
    pub hits: Vec<FileSearchHit>,
    pub total_files: usize,
    pub total_matches: usize,
    pub query_time_ms: f64,
}

/// A single file search hit (with matching lines).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchHit {
    pub path: String,
    pub name: String,
    pub match_count: usize,
    pub matches: Vec<FileMatchLine>,
}

/// A matching line within a file.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMatchLine {
    pub line_number: usize,
    pub line_content: String,
    /// Highlight positions within line_content: [[start, end], ...]
    pub highlights: Vec<[usize; 2]>,
}
