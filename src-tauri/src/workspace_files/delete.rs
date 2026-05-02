//! Delete a file or directory inside the workspace.
//!
//! Used by SimpleChatInput's Cmd+Z undo for file references — it deletes the
//! attachment that was just copied into `myagents_files/`. We use
//! `symlink_metadata` (NOT `metadata`) so a broken symlink reports as a file
//! and gets removed cleanly. v0.2.5 hit a sidecar crash where `metadata`
//! followed a broken symlink and called into a sync `cpSync`-style path
//! checking; lesson is enshrined in CLAUDE.md red-line table.

use std::fs;

use serde::Serialize;

use super::path_safety::{resolve_inside_workspace, validate_workspace_root};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResult {
    pub success: bool,
    pub deleted: bool,
}

#[tauri::command]
pub async fn cmd_workspace_delete(
    workspace: String,
    path: String,
) -> Result<DeleteResult, String> {
    let workspace_root = validate_workspace_root(&workspace)?;
    let target = resolve_inside_workspace(&workspace_root, &path)?;

    // Refuse to delete the workspace root itself.
    if target == workspace_root {
        return Err("Refusing to delete workspace root".to_string());
    }

    let metadata = match fs::symlink_metadata(&target) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(DeleteResult {
                success: true,
                deleted: false,
            });
        }
        Err(e) => return Err(format!("stat failed: {}", e)),
    };

    let res = if metadata.is_symlink() || metadata.is_file() {
        fs::remove_file(&target)
    } else if metadata.is_dir() {
        fs::remove_dir_all(&target)
    } else {
        return Err("Unsupported file type".to_string());
    };

    res.map_err(|e| format!("Failed to delete {}: {}", path, e))?;
    Ok(DeleteResult {
        success: true,
        deleted: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_files::test_support::make_test_workspace;
    use std::path::PathBuf;

    fn make_tmp_workspace() -> PathBuf {
        make_test_workspace("delete")
    }

    #[tokio::test]
    async fn deletes_file() {
        let ws = make_tmp_workspace();
        fs::write(ws.join("a.txt"), "x").unwrap();
        let res = cmd_workspace_delete(ws.to_string_lossy().to_string(), "a.txt".to_string())
            .await
            .unwrap();
        assert!(res.deleted);
        assert!(!ws.join("a.txt").exists());
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn deletes_directory_recursively() {
        let ws = make_tmp_workspace();
        let sub = ws.join("dir");
        fs::create_dir_all(sub.join("nested")).unwrap();
        fs::write(sub.join("a.txt"), "x").unwrap();
        let res = cmd_workspace_delete(ws.to_string_lossy().to_string(), "dir".to_string())
            .await
            .unwrap();
        assert!(res.deleted);
        assert!(!sub.exists());
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn missing_returns_not_deleted_not_error() {
        let ws = make_tmp_workspace();
        let res = cmd_workspace_delete(
            ws.to_string_lossy().to_string(),
            "missing.txt".to_string(),
        )
        .await
        .unwrap();
        assert!(!res.deleted);
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn rejects_workspace_root_itself() {
        let ws = make_tmp_workspace();
        let res =
            cmd_workspace_delete(ws.to_string_lossy().to_string(), "".to_string()).await;
        assert!(res.is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn rejects_traversal() {
        let ws = make_tmp_workspace();
        let res = cmd_workspace_delete(
            ws.to_string_lossy().to_string(),
            "../escape".to_string(),
        )
        .await;
        assert!(res.is_err());
        let _ = fs::remove_dir_all(&ws);
    }

    // v0.2.5 regression: broken symlink crashed the sidecar. Verify Rust path
    // handles it cleanly by removing the broken link as a "file".
    #[cfg(unix)]
    #[tokio::test]
    async fn deletes_broken_symlink() {
        use std::os::unix::fs::symlink;
        let ws = make_tmp_workspace();
        symlink("/nonexistent/target", ws.join("broken")).unwrap();
        let res = cmd_workspace_delete(
            ws.to_string_lossy().to_string(),
            "broken".to_string(),
        )
        .await
        .unwrap();
        assert!(res.deleted);
        assert!(!ws.join("broken").exists());
        // exists() returns false for broken symlinks, so we also verify it's gone via symlink_metadata
        assert!(fs::symlink_metadata(ws.join("broken")).is_err());
        let _ = fs::remove_dir_all(&ws);
    }
}
