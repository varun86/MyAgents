//! Workspace file IO commands.
//!
//! This module is the canonical home for "operations against a workspace path"
//! that the SimpleChatInput / DirectoryPanel surfaces depend on. They live in
//! Rust (not the Node sidecar) for two reasons:
//!
//! 1. **Decoupling from Session lifetime** — the launcher input has no Sidecar,
//!    but it still needs to upload files, search by name, and list slash
//!    commands. Putting these operations in Tauri lets every entry point
//!    (launcher, chat tab, future cloud client) call the same functions
//!    without spinning up a Sidecar.
//!
//! 2. **Pit-of-success** — workspace files are an OS resource, not an AI
//!    runtime resource. Anchoring them in Tauri makes "no Sidecar dependency"
//!    the default; trying to call out to HTTP would require a separate, more
//!    awkward path.
//!
//! Architectural rule (CLAUDE.md red-line table): the renderer MUST go through
//! these `cmd_workspace_*` invokes for any workspace file operation. The
//! sidecar HTTP endpoints they replace (`/api/files/import-base64`,
//! `/agent/search-files`, `/api/commands`, …) are scheduled for deletion in
//! Phase E after DirectoryPanel migrates too. ESLint enforcement covers the
//! transition.

pub mod delete;
pub mod files_b64;
pub mod gitignore;
pub mod path_safety;
pub mod search;
pub mod slash;
pub mod transfer;
#[cfg(test)]
pub(crate) mod test_support;

// Re-export the Tauri commands so `lib.rs` can register them with one
// `generate_handler!` line per module rather than reaching into each file.
pub use delete::cmd_workspace_delete;
pub use files_b64::{cmd_workspace_import_files_b64, cmd_workspace_read_files_b64};
pub use gitignore::cmd_workspace_add_gitignore;
pub use search::cmd_workspace_search_files_fuzzy;
pub use slash::cmd_list_slash_commands;
pub use transfer::cmd_workspace_copy_paths;
