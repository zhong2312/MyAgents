/// Stable lexical workspace identity shared by Rust domains.
///
/// This intentionally does not canonicalize because historical tasks and
/// sessions may reference workspaces that are not currently mounted.
pub(crate) fn normalize_workspace_path_identity(path: &str) -> String {
    let windows_style = (path.len() >= 2 && path.as_bytes()[1] == b':')
        || path.starts_with("\\\\")
        || path.starts_with("//");
    let mut normalized = if windows_style {
        path.replace('\\', "/")
    } else {
        path.to_string()
    };
    if normalized.is_empty() {
        return normalized;
    }

    let bytes = normalized.as_bytes();
    let min_len = if bytes.len() >= 3 && bytes[1] == b':' && bytes[2] == b'/' {
        3
    } else if normalized.starts_with("//") {
        2
    } else if normalized.starts_with('/') {
        1
    } else {
        0
    };
    while normalized.len() > min_len && normalized.ends_with('/') {
        normalized.pop();
    }

    if (normalized.len() >= 2 && normalized.as_bytes()[1] == b':') || normalized.starts_with("//") {
        normalized.make_ascii_lowercase();
    }
    normalized
}

pub(crate) fn workspace_paths_equal(left: &str, right: &str) -> bool {
    normalize_workspace_path_identity(left) == normalize_workspace_path_identity(right)
}

#[cfg(test)]
mod tests {
    use super::workspace_paths_equal;

    #[test]
    fn windows_workspace_identity_ignores_separator_case_and_trailing_slash() {
        assert!(workspace_paths_equal(
            r"F:\workspace\小说\DSXX\",
            "f:/workspace/小说/DSXX"
        ));
    }

    #[test]
    fn different_workspaces_remain_distinct() {
        assert!(!workspace_paths_equal(
            r"F:\workspace\小说\DSXX",
            "F:/workspace/小说/OTHER"
        ));
    }
}
