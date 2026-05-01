//! `.gitignore` pattern injection.
//!
//! Used right after `myagents_files/` is populated to ensure the imported
//! attachments don't get committed by mistake. Idempotent: if the pattern
//! already matches a line, we no-op.

use std::fs;
use std::io::Write;

use serde::Serialize;

use super::path_safety::validate_workspace_root;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitignoreResult {
    pub success: bool,
    pub added: bool,
    pub reason: String,
}

#[tauri::command]
pub async fn cmd_workspace_add_gitignore(
    workspace: String,
    pattern: String,
) -> Result<GitignoreResult, String> {
    if pattern.trim().is_empty() {
        return Err("pattern is required".to_string());
    }

    let workspace_root = validate_workspace_root(&workspace)?;
    let gitignore_path = workspace_root.join(".gitignore");

    if !gitignore_path.exists() {
        fs::write(&gitignore_path, format!("{}\n", pattern))
            .map_err(|e| format!("Failed to create .gitignore: {}", e))?;
        return Ok(GitignoreResult {
            success: true,
            added: true,
            reason: "created new .gitignore".to_string(),
        });
    }

    let existing = fs::read_to_string(&gitignore_path)
        .map_err(|e| format!("Failed to read .gitignore: {}", e))?;
    let trimmed = pattern.trim();
    if existing.lines().any(|l| l.trim() == trimmed) {
        return Ok(GitignoreResult {
            success: true,
            added: false,
            reason: "pattern already exists".to_string(),
        });
    }

    let mut file = fs::OpenOptions::new()
        .append(true)
        .open(&gitignore_path)
        .map_err(|e| format!("Failed to open .gitignore: {}", e))?;
    let prefix = if existing.ends_with('\n') { "" } else { "\n" };
    writeln!(file, "{}{}", prefix, pattern)
        .map_err(|e| format!("Failed to append .gitignore: {}", e))?;

    Ok(GitignoreResult {
        success: true,
        added: true,
        reason: "appended".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace_files::test_support::make_test_workspace;
    use std::path::PathBuf;

    fn make_tmp_workspace() -> PathBuf {
        make_test_workspace("gitignore")
    }

    #[tokio::test]
    async fn creates_when_missing() {
        let ws = make_tmp_workspace();
        let res = cmd_workspace_add_gitignore(
            ws.to_string_lossy().to_string(),
            "myagents_files/".to_string(),
        )
        .await
        .unwrap();
        assert!(res.added);
        assert_eq!(
            fs::read_to_string(ws.join(".gitignore")).unwrap(),
            "myagents_files/\n"
        );
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn idempotent_when_pattern_present() {
        let ws = make_tmp_workspace();
        fs::write(ws.join(".gitignore"), "myagents_files/\nnode_modules\n").unwrap();
        let res = cmd_workspace_add_gitignore(
            ws.to_string_lossy().to_string(),
            "myagents_files/".to_string(),
        )
        .await
        .unwrap();
        assert!(!res.added);
        assert_eq!(
            fs::read_to_string(ws.join(".gitignore")).unwrap(),
            "myagents_files/\nnode_modules\n"
        );
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn appends_when_no_trailing_newline() {
        let ws = make_tmp_workspace();
        fs::write(ws.join(".gitignore"), "node_modules").unwrap();
        let res = cmd_workspace_add_gitignore(
            ws.to_string_lossy().to_string(),
            "myagents_files/".to_string(),
        )
        .await
        .unwrap();
        assert!(res.added);
        assert_eq!(
            fs::read_to_string(ws.join(".gitignore")).unwrap(),
            "node_modules\nmyagents_files/\n"
        );
        let _ = fs::remove_dir_all(&ws);
    }

    #[tokio::test]
    async fn rejects_empty_pattern() {
        let ws = make_tmp_workspace();
        let res =
            cmd_workspace_add_gitignore(ws.to_string_lossy().to_string(), "  ".to_string()).await;
        assert!(res.is_err());
        let _ = fs::remove_dir_all(&ws);
    }
}
