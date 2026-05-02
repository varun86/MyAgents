//! Platform-specific skill block list.
//!
//! Mirrors `src/server/utils/platform.ts::PLATFORM_BLOCKED_SKILLS`. Both
//! `slash.rs` (picker UI) and `skill_sync.rs` (symlink mirroring) need the
//! same answer to "should we expose this skill on this OS?". Centralized
//! here so adding a new platform block is a one-line change instead of two.

/// Returns `true` if the skill folder name is blocked on the current
/// platform. Today this only blocks `agent-browser` on Windows (upstream
/// Playwright bug); structure leaves room for more entries.
pub fn is_skill_blocked_on_platform(folder: &str) -> bool {
    #[cfg(target_os = "windows")]
    {
        if folder == "agent-browser" {
            return true;
        }
    }
    let _ = folder;
    false
}
