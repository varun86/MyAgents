//! Centralized application data directory and PID lock file management.
//!
//! All code that needs `~/.myagents/` SHOULD use [`myagents_data_dir()`] instead of
//! hardcoding the path. This enables future dev/prod isolation (separate data dirs
//! for debug vs release builds) with a single change to this module.
//!
//! ## PID Lock File
//!
//! `~/.myagents/app.lock` contains the PID of the running MyAgents instance.
//! - Written by [`acquire_lock()`] during app startup (after single-instance check).
//! - Read by build scripts (`build_dev.sh`, `start_dev.sh`) to precisely kill the
//!   running instance before starting a new one.
//! - Removed by [`release_lock()`] on graceful exit.
//!
//! The **return value** of [`acquire_lock`] is also used by [`crate::sidecar::
//! cleanup_stale_sidecars`] to decide whether to scan for orphaned child
//! processes: on a truly fresh launch ([`LockAcquireResult::FreshLaunch`])
//! there cannot be any orphans, so the scan is skipped — this alone saves
//! 5–15 seconds on first launch under Windows Defender.

use std::fs;
use std::path::PathBuf;

use crate::{ulog_error, ulog_info, ulog_warn};

/// Outcome of [`acquire_lock`] — encodes whether a prior MyAgents instance
/// existed on this machine when we started.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LockAcquireResult {
    /// No lock file present — truly first launch on this machine (or after
    /// full uninstall / manual data wipe). Caller can skip stale-process
    /// scans because there are no possible orphans.
    FreshLaunch,
    /// Lock file existed and pointed at a live MyAgents process — we killed
    /// it before taking over. Orphan children are likely.
    ReplacedRunning,
    /// Lock file existed but pointed at a dead PID — previous instance
    /// crashed. Orphan children are highly likely.
    CrashRecovery,
}

impl LockAcquireResult {
    /// `true` if a prior MyAgents instance may have left orphaned child
    /// processes. The startup cleanup pass should run.
    pub fn had_prior_instance(self) -> bool {
        !matches!(self, Self::FreshLaunch)
    }
}

/// Return the MyAgents data directory (`~/.myagents/` by default).
///
/// Future: debug builds may return `~/.myagents-dev/` to enable simultaneous
/// dev/prod operation with fully isolated state (config, bots, sidecars, ports).
/// For now, both profiles share the same directory.
pub fn myagents_data_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".myagents"))
}

/// Path to the PID lock file.
fn lock_file_path() -> Option<PathBuf> {
    myagents_data_dir().map(|d| d.join("app.lock"))
}

/// Write the current process PID to `~/.myagents/app.lock` and report
/// whether a prior instance's state was encountered.
///
/// If an existing lock file contains a PID of a still-running MyAgents process,
/// that process is killed with SIGKILL before the new PID is written. This handles
/// the case where macOS auto-restarts a killed `.app` (Automatic Termination)
/// before the new build starts, leaving two instances fighting over shared resources.
///
/// Called once in `lib.rs` `setup()`, after the Tauri single-instance plugin has
/// already handled the normal "user double-clicked the app" scenario.
pub fn acquire_lock() -> LockAcquireResult {
    let Some(lock_path) = lock_file_path() else {
        // No home dir known — treat as fresh (best-effort). There's nothing
        // we could clean up anyway, so skipping the scan is safe.
        return LockAcquireResult::FreshLaunch;
    };

    // Ensure parent dir exists
    if let Some(parent) = lock_path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    // Read existing lock — classify what we found.
    let result = match fs::read_to_string(&lock_path) {
        Ok(content) => {
            match content.trim().parse::<u32>() {
                Ok(old_pid) => {
                    let current_pid = std::process::id();
                    if old_pid == current_pid {
                        // Our own stale PID? Happens if a previous process
                        // with the same PID (rare) or we're restarting in
                        // place. Treat as crash recovery.
                        LockAcquireResult::CrashRecovery
                    } else if is_myagents_process(old_pid) {
                        ulog_warn!(
                            "[app-lock] Killing stale MyAgents instance (PID {}) before acquiring lock",
                            old_pid
                        );
                        kill_pid(old_pid);
                        // Give it a moment to die (SIGKILL is near-instant on modern kernels)
                        std::thread::sleep(std::time::Duration::from_millis(300));
                        LockAcquireResult::ReplacedRunning
                    } else {
                        LockAcquireResult::CrashRecovery
                    }
                }
                Err(_) => LockAcquireResult::CrashRecovery, // corrupted file
            }
        }
        Err(_) => LockAcquireResult::FreshLaunch,
    };

    // Write our PID
    let pid = std::process::id();
    if let Err(e) = fs::write(&lock_path, pid.to_string()) {
        ulog_error!("[app-lock] Failed to write lock file: {}", e);
    } else {
        ulog_info!("[app-lock] Lock acquired (PID {}, prior={:?})", pid, result);
    }

    result
}

/// Remove the lock file on graceful exit.
///
/// Only removes if the file still contains OUR PID (another instance may have
/// overwritten it if we're being replaced).
pub fn release_lock() {
    let Some(lock_path) = lock_file_path() else { return };
    let current_pid = std::process::id().to_string();

    match fs::read_to_string(&lock_path) {
        Ok(content) if content.trim() == current_pid => {
            let _ = fs::remove_file(&lock_path);
            ulog_info!("[app-lock] Lock released (PID {})", current_pid);
        }
        _ => {
            // Lock file doesn't exist or belongs to another instance — don't touch it
        }
    }
}

/// Check if a PID belongs to a running MyAgents process (not just any process).
/// Prevents SIGKILL-ing an unrelated process that recycled the stale PID.
///
/// Unified implementation via `sysinfo` — native API on both platforms, no
/// subprocess spawn (replacing the prior `ps -p …` on Unix and `tasklist`
/// on Windows which cost 100–500 ms each).
fn is_myagents_process(pid: u32) -> bool {
    // First check existence cheaply via `kill(pid, 0)` on Unix, or skip on
    // Windows where sysinfo already short-circuits on unknown PIDs.
    #[cfg(unix)]
    {
        // SAFETY: kill(pid, 0) checks process existence without sending a signal.
        // Valid for any positive PID; signal 0 is always safe.
        let alive = unsafe { libc::kill(pid as i32, 0) == 0 };
        if !alive {
            return false;
        }
    }

    crate::process_cleanup::is_myagents_pid(pid)
}

/// Kill a process with SIGKILL (Unix) or TerminateProcess (Windows).
#[cfg(unix)]
fn kill_pid(pid: u32) {
    // SAFETY: SIGKILL is a valid signal for any PID we own permission to kill.
    // Caller has already verified this PID is a MyAgents process.
    unsafe {
        libc::kill(pid as i32, libc::SIGKILL);
    }
}

#[cfg(windows)]
fn kill_pid(pid: u32) {
    // /F = force, /T = kill process tree, /PID = target
    // Uses process_cmd::new() to set CREATE_NO_WINDOW (prevents console flash).
    let _ = crate::process_cmd::new("taskkill")
        .args(["/F", "/T", "/PID", &pid.to_string()])
        .output();
}
