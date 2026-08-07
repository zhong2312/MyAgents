use tauri::webview::ScrollBarStyle;

/// Resolve the one native scrollbar policy shared by every MyAgents WebView.
///
/// WebView2 requires every WebView targeting the same data directory to use
/// the same scrollbar style. Keep that choice here instead of letting window
/// builders or Renderer CSS become competing appearance owners.
pub(crate) fn scroll_bar_style() -> ScrollBarStyle {
    #[cfg(target_os = "windows")]
    {
        ScrollBarStyle::FluentOverlay
    }

    #[cfg(not(target_os = "windows"))]
    {
        ScrollBarStyle::Default
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};

    #[test]
    #[cfg(target_os = "windows")]
    fn windows_uses_fluent_overlay_scrollbars() {
        assert!(matches!(scroll_bar_style(), ScrollBarStyle::FluentOverlay));
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn non_windows_keeps_the_platform_default_scrollbars() {
        assert!(matches!(scroll_bar_style(), ScrollBarStyle::Default));
    }

    #[test]
    fn every_webview_builder_uses_the_shared_scrollbar_policy() {
        fn rust_sources(dir: &Path, files: &mut Vec<PathBuf>) {
            for entry in fs::read_dir(dir).expect("read Rust source directory") {
                let path = entry.expect("read Rust source entry").path();
                if path.is_dir() {
                    rust_sources(&path, files);
                } else if path.extension().and_then(|ext| ext.to_str()) == Some("rs") {
                    files.push(path);
                }
            }
        }

        let source_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let policy_path = source_root.join("webview_policy.rs");
        let mut files = Vec::new();
        rust_sources(&source_root, &mut files);

        let mut total_builders = 0;
        for path in files {
            if path == policy_path {
                continue;
            }
            let source = fs::read_to_string(&path).expect("read Rust source file");
            let builder_count = source.matches("WebviewWindowBuilder::new").count()
                + source.matches("WebviewWindowBuilder::from_config").count()
                + source.matches("WebviewBuilder::new").count();
            if builder_count == 0 {
                continue;
            }

            let policy_count = source
                .matches(".scroll_bar_style(crate::webview_policy::scroll_bar_style())")
                .count();
            assert_eq!(
                builder_count,
                policy_count,
                "every WebView builder in {} must use the shared native scrollbar policy",
                path.display()
            );
            total_builders += builder_count;
        }

        assert!(
            total_builders > 0,
            "the builder policy guard must inspect production builders"
        );
    }
}
