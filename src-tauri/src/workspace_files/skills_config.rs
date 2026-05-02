//! Read-only access to `~/.myagents/skills-config.json`.
//!
//! Both `slash.rs` (picker UI) and `skill_sync.rs` (symlink mirroring) need
//! the user-disabled list. Two parallel readers were drifting (one even
//! pointed at the wrong file path); centralized here so the next "also read
//! field X" change is a one-line edit instead of two.
//!
//! Schema parity with sidecar `interface SkillsConfig`. We only deserialize
//! `disabled` because nothing else is needed at the Rust callsites today;
//! `seeded` and `generation` are owned by the sidecar's seeding/generation
//! optimization paths.

use std::fs;
use std::path::Path;

use serde::Deserialize;

#[derive(Debug, Default, Deserialize)]
struct SkillsConfig {
    #[serde(default)]
    disabled: Vec<String>,
}

/// Read the user's disabled-skill list from `~/.myagents/skills-config.json`.
/// Returns an empty list if the file is missing, unreadable, or malformed —
/// safe default lets the caller continue without disabling anything.
pub fn read_disabled_list(myagents_root: &Path) -> Vec<String> {
    let path = myagents_root.join("skills-config.json");
    if !path.is_file() {
        return Vec::new();
    }
    match fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str::<SkillsConfig>(&content)
            .map(|c| c.disabled)
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}
