//! Application-owned retention for abnormal Sidecar crash artifacts.
//!
//! Node Sidecars are short-lived and concurrent, so they only own their lazy
//! per-process writer. The always-present Tauri process is the single authority
//! that removes historical artifacts at startup and once per hour.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use crate::{ulog_info, ulog_warn};

const CRASH_MAX_AGE: Duration = Duration::from_secs(30 * 24 * 60 * 60);
const CRASH_MAX_FILES: usize = 20;
const CRASH_MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;
const CRASH_MAX_DIR_BYTES: u64 = 200 * 1024 * 1024;
const SWEEP_INTERVAL: Duration = Duration::from_secs(60 * 60);

#[derive(Debug, Clone, Copy)]
struct CrashRetentionPolicy {
    max_age: Duration,
    max_files: usize,
    max_file_bytes: u64,
    max_dir_bytes: u64,
}

const DEFAULT_POLICY: CrashRetentionPolicy = CrashRetentionPolicy {
    max_age: CRASH_MAX_AGE,
    max_files: CRASH_MAX_FILES,
    max_file_bytes: CRASH_MAX_FILE_BYTES,
    max_dir_bytes: CRASH_MAX_DIR_BYTES,
};

#[derive(Debug)]
struct CrashArtifact {
    path: PathBuf,
    filename: String,
    modified: SystemTime,
    size: u64,
}

#[derive(Debug, Default, PartialEq, Eq)]
struct CrashRetentionResult {
    scanned: usize,
    age_deleted: usize,
    oversized_deleted: usize,
    budget_deleted: usize,
    files_after: usize,
    bytes_after: u64,
}

/// Start the one application-lifetime owner. The first pass handles upgrade
/// backlog even if no Global or Session Sidecar is ever started.
pub fn start_crash_artifact_retention_owner() {
    let Some(data_dir) = crate::app_dirs::myagents_data_dir() else {
        ulog_warn!("[crash-retention] Home directory unavailable; retention disabled");
        return;
    };
    let crash_dir = data_dir.join("logs").join("crash");

    tauri::async_runtime::spawn(async move {
        loop {
            let sweep_dir = crash_dir.clone();
            match tauri::async_runtime::spawn_blocking(move || {
                sweep_crash_artifacts(&sweep_dir, DEFAULT_POLICY, SystemTime::now())
            })
            .await
            {
                Ok(result)
                    if result.age_deleted + result.oversized_deleted + result.budget_deleted
                        > 0 =>
                {
                    ulog_info!(
                        "[crash-retention] age_deleted={} oversized_deleted={} budget_deleted={} remaining={} bytes={}",
                        result.age_deleted,
                        result.oversized_deleted,
                        result.budget_deleted,
                        result.files_after,
                        result.bytes_after,
                    );
                }
                Ok(_) => {}
                Err(error) => {
                    ulog_warn!("[crash-retention] sweep task failed: {}", error);
                }
            }
            tokio::time::sleep(SWEEP_INTERVAL).await;
        }
    });
}

fn sweep_crash_artifacts(
    crash_dir: &Path,
    policy: CrashRetentionPolicy,
    now: SystemTime,
) -> CrashRetentionResult {
    let Ok(entries) = fs::read_dir(crash_dir) else {
        // Do not create an empty directory for healthy application lifetimes.
        return CrashRetentionResult::default();
    };

    let mut result = CrashRetentionResult::default();
    let mut survivors = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("log") {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }

        result.scanned += 1;
        let artifact = CrashArtifact {
            filename: entry.file_name().to_string_lossy().into_owned(),
            path,
            modified: metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
            size: metadata.len(),
        };

        let is_oversized = artifact.size > policy.max_file_bytes;
        let is_expired = now
            .duration_since(artifact.modified)
            .is_ok_and(|age| age > policy.max_age);
        if is_oversized || is_expired {
            if fs::remove_file(&artifact.path).is_ok() {
                if is_oversized {
                    result.oversized_deleted += 1;
                } else {
                    result.age_deleted += 1;
                }
                continue;
            }
        }
        survivors.push(artifact);
    }

    // Oldest first. Filename is a stable tie-breaker on coarse-mtime filesystems.
    survivors.sort_by(|left, right| {
        left.modified
            .cmp(&right.modified)
            .then_with(|| left.filename.cmp(&right.filename))
    });
    let mut total_bytes = survivors.iter().map(|file| file.size).sum::<u64>();
    let mut candidate = 0;
    while (survivors.len() > policy.max_files || total_bytes > policy.max_dir_bytes)
        && candidate < survivors.len()
    {
        if fs::remove_file(&survivors[candidate].path).is_ok() {
            let removed = survivors.remove(candidate);
            total_bytes = total_bytes.saturating_sub(removed.size);
            result.budget_deleted += 1;
        } else {
            candidate += 1;
        }
    }

    result.files_after = survivors.len();
    result.bytes_after = total_bytes;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn policy(max_files: usize, max_file_bytes: u64, max_dir_bytes: u64) -> CrashRetentionPolicy {
        CrashRetentionPolicy {
            max_age: Duration::from_secs(100),
            max_files,
            max_file_bytes,
            max_dir_bytes,
        }
    }

    fn write_sized(path: &Path, bytes: usize) {
        let mut file = fs::File::create(path).unwrap();
        file.write_all(&vec![b'x'; bytes]).unwrap();
    }

    #[test]
    fn healthy_startup_does_not_materialize_the_crash_directory() {
        let root = tempfile::tempdir().unwrap();
        let crash_dir = root.path().join("logs").join("crash");

        let result = sweep_crash_artifacts(&crash_dir, DEFAULT_POLICY, SystemTime::now());

        assert_eq!(result, CrashRetentionResult::default());
        assert!(!crash_dir.exists());
    }

    #[test]
    fn removes_expired_and_historical_oversized_artifacts() {
        let root = tempfile::tempdir().unwrap();
        write_sized(&root.path().join("expired.log"), 1);
        write_sized(&root.path().join("oversized.log"), 11);
        let modified = fs::metadata(root.path().join("expired.log"))
            .unwrap()
            .modified()
            .unwrap();

        let result = sweep_crash_artifacts(
            root.path(),
            policy(20, 10, 100),
            modified + Duration::from_secs(101),
        );

        assert_eq!(result.age_deleted, 1);
        assert_eq!(result.oversized_deleted, 1);
        assert_eq!(result.files_after, 0);
    }

    #[test]
    fn evicts_oldest_until_both_count_and_directory_budgets_hold() {
        let root = tempfile::tempdir().unwrap();
        for filename in ["a.log", "b.log", "c.log", "d.log"] {
            write_sized(&root.path().join(filename), 6);
        }

        let result = sweep_crash_artifacts(root.path(), policy(3, 50, 12), SystemTime::now());

        assert_eq!(result.budget_deleted, 2);
        assert_eq!(result.files_after, 2);
        assert_eq!(result.bytes_after, 12);
    }
}
