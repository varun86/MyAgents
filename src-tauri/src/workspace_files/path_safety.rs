//! Workspace path resolution and traversal protection.
//!
//! All workspace file commands take an absolute `workspace_path` (the directory
//! the user is currently working inside) and a `relative` path or `target_dir`
//! the operation should affect. This module is the single chokepoint that turns
//! that pair into a validated absolute path that:
//!
//! 1. Resolves `..` and `.` components (no traversal escape).
//! 2. Stays inside `workspace_path` (no escape via symlink-aware canonicalization
//!    where the file already exists; for new paths we walk component-by-component).
//! 3. Passes the same system / credential directory blacklist used everywhere
//!    else in the app — see `commands::validate_file_path`.
//!
//! Centralizing these rules means a future "ah, also block X" only happens once.
//! Callers MUST go through `resolve_inside_workspace`; bypassing it is a bug.
//!
//! Symlink note: we deliberately do NOT canonicalize-then-prefix-check, because
//! canonicalize errors on non-existent paths (which is fine for read but breaks
//! write). Instead we resolve `..`/`.` lexically, then check `starts_with`. A
//! symlink inside the workspace pointing outside is therefore reachable through
//! these commands — that's consistent with the prior sidecar behavior and with
//! what users expect when they put a symlink in their own project.

use std::path::{Component, Path, PathBuf};

use crate::commands::validate_file_path as system_blacklist_check;

/// Errors are stringly-typed because Tauri commands serialize errors as strings
/// to the frontend; matching the existing error style avoids a translation layer.
pub type WfResult<T> = Result<T, String>;

/// Validate the workspace root itself: must be absolute, must not target a
/// blacklisted system / credential directory, must currently exist.
///
/// We require existence here (unlike validate_file_path which is read-only) so
/// that an invalid workspace_path can never silently create files in `/`.
pub fn validate_workspace_root(workspace_path: &str) -> WfResult<PathBuf> {
    let resolved = system_blacklist_check(workspace_path)?;
    if !resolved.is_dir() {
        return Err(format!(
            "Workspace path is not a directory or does not exist: {}",
            workspace_path
        ));
    }
    Ok(resolved)
}

/// Resolve a `relative` path inside `workspace_root`. The relative segment may
/// also be empty / "." — in which case the workspace root itself is returned.
///
/// Rules:
/// - `relative` MUST be relative (no leading `/` or drive letter).
/// - `..` is allowed inside the segment but cannot escape `workspace_root`.
/// - Resulting path is checked against the system blacklist as a final guard
///   (defense-in-depth in case the workspace itself sits next to a blacklisted
///   dir and the relative includes `../...`).
pub fn resolve_inside_workspace(workspace_root: &Path, relative: &str) -> WfResult<PathBuf> {
    if Path::new(relative).is_absolute() {
        return Err("Path must be relative to workspace root".to_string());
    }

    let mut resolved = workspace_root.to_path_buf();
    for component in Path::new(relative).components() {
        match component {
            Component::ParentDir => {
                if resolved == *workspace_root {
                    return Err("Path escapes workspace root".to_string());
                }
                resolved.pop();
            }
            Component::CurDir => {}
            Component::Normal(part) => resolved.push(part),
            Component::Prefix(_) | Component::RootDir => {
                return Err("Absolute / drive-letter components not allowed".to_string());
            }
        }
    }

    if !resolved.starts_with(workspace_root) {
        return Err("Path escapes workspace root".to_string());
    }

    // Final blacklist check — covers the case where the workspace itself is
    // adjacent to a sensitive dir and a malicious `relative` walked into it.
    if let Some(s) = resolved.to_str() {
        let _ = system_blacklist_check(s)?;
    }

    Ok(resolved)
}

/// Validate that an arbitrary absolute path (e.g. a file the user dragged from
/// Finder) is safe to read from. Used by `read_files_b64` and `copy_paths`.
pub fn validate_external_read_path(absolute_path: &str) -> WfResult<PathBuf> {
    system_blacklist_check(absolute_path)
}

/// Reject filenames that would break on Windows or hide the file (`.`, `..`,
/// names beginning with whitespace, names containing path separators, NTFS
/// reserved names, and the Windows reserved character set).
///
/// This is the Rust equivalent of the sidecar's `isValidItemName`.
pub fn validate_item_name(name: &str) -> WfResult<()> {
    if name.is_empty() || name.trim().is_empty() {
        return Err("Name cannot be empty".to_string());
    }
    if name != name.trim() {
        return Err("Name cannot start or end with whitespace".to_string());
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("Name cannot contain path separators or '..'".to_string());
    }
    if name.chars().any(|c| matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*')) {
        return Err("Name contains invalid characters".to_string());
    }
    if name.chars().any(|c| (c as u32) < 0x20 || c == '\x7f') {
        return Err("Name contains control characters".to_string());
    }
    if name.chars().all(|c| c == '.') {
        return Err("Name cannot be only dots".to_string());
    }
    if is_windows_reserved_name(name) {
        return Err(format!("'{}' is a reserved Windows filename", name));
    }
    Ok(())
}

fn is_windows_reserved_name(name: &str) -> bool {
    let stem = name
        .split_once('.')
        .map(|(s, _)| s)
        .unwrap_or(name)
        .to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL"
            | "COM1" | "COM2" | "COM3" | "COM4" | "COM5"
            | "COM6" | "COM7" | "COM8" | "COM9"
            | "LPT1" | "LPT2" | "LPT3" | "LPT4" | "LPT5"
            | "LPT6" | "LPT7" | "LPT8" | "LPT9"
    )
}

/// Sanitize a filename for filesystem write — strips Windows-illegal chars by
/// replacing them with `_`. Different from `validate_item_name`, which rejects
/// rather than fixes (used at the API boundary for explicit user-typed names).
/// This one is for "user uploaded a file called `foo<bar>.pdf`" — fix not reject.
pub fn sanitize_filename(name: &str) -> String {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return "untitled".to_string();
    }
    trimmed
        .chars()
        .map(|c| {
            if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
                '_'
            } else if (c as u32) < 0x20 || c == '\x7f' {
                '_'
            } else {
                c
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_files::test_support::make_test_workspace;
    use std::fs;

    fn make_tmp_workspace() -> PathBuf {
        make_test_workspace("path_safety")
    }

    #[test]
    fn rejects_relative_workspace_root() {
        assert!(validate_workspace_root("relative/path").is_err());
    }

    #[test]
    fn accepts_existing_dir() {
        let ws = make_tmp_workspace();
        let resolved = validate_workspace_root(ws.to_str().unwrap()).unwrap();
        assert_eq!(resolved, ws);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn rejects_blacklisted_dir() {
        // /etc exists on macOS/Linux; on Windows fall back to C:\Windows
        #[cfg(not(windows))]
        let blacklisted = "/etc";
        #[cfg(windows)]
        let blacklisted = "C:\\Windows";
        assert!(validate_workspace_root(blacklisted).is_err());
    }

    #[test]
    fn resolve_simple_relative() {
        let ws = make_tmp_workspace();
        let resolved = resolve_inside_workspace(&ws, "sub/file.txt").unwrap();
        assert_eq!(resolved, ws.join("sub").join("file.txt"));
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn resolve_dot_returns_root() {
        let ws = make_tmp_workspace();
        let resolved = resolve_inside_workspace(&ws, "").unwrap();
        assert_eq!(resolved, ws);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn rejects_absolute_relative() {
        let ws = make_tmp_workspace();
        assert!(resolve_inside_workspace(&ws, "/etc/passwd").is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn rejects_traversal_escape() {
        let ws = make_tmp_workspace();
        assert!(resolve_inside_workspace(&ws, "../etc").is_err());
        assert!(resolve_inside_workspace(&ws, "a/../../etc").is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn allows_internal_traversal() {
        let ws = make_tmp_workspace();
        // a/b/.. == a — legal
        let resolved = resolve_inside_workspace(&ws, "a/b/../c").unwrap();
        assert_eq!(resolved, ws.join("a").join("c"));
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn validate_item_name_allows_unicode() {
        assert!(validate_item_name("说明.md").is_ok());
        assert!(validate_item_name("file_1-2.txt").is_ok());
    }

    #[test]
    fn validate_item_name_rejects_separators() {
        assert!(validate_item_name("a/b").is_err());
        assert!(validate_item_name("a\\b").is_err());
        assert!(validate_item_name("..").is_err());
    }

    #[test]
    fn validate_item_name_rejects_windows_reserved() {
        assert!(validate_item_name("CON").is_err());
        assert!(validate_item_name("con.txt").is_err());
        assert!(validate_item_name("LPT1.log").is_err());
    }

    #[test]
    fn validate_item_name_rejects_control_chars() {
        assert!(validate_item_name("a\x00b").is_err());
        assert!(validate_item_name("\tfoo").is_err());
    }

    #[test]
    fn sanitize_strips_illegal_chars() {
        assert_eq!(sanitize_filename("foo<bar>.pdf"), "foo_bar_.pdf");
        assert_eq!(sanitize_filename("a:b/c"), "a_b_c");
    }

    #[test]
    fn sanitize_falls_back_to_untitled() {
        assert_eq!(sanitize_filename(""), "untitled");
        assert_eq!(sanitize_filename("   "), "untitled");
    }
}
