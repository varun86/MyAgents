/**
 * UnifiedLogger — Pattern 6 (Buffered async writer + bounded logs).
 *
 * Persists merged React/Node/Rust logs to ~/.myagents/logs/unified-{date}.log.
 *
 * Pattern 6 changes vs v0.1.x:
 *   - Replaced per-call sync writes (Audit F P2 finding — every entry used
 *     to open / write / close inline) with an in-memory queue drained by a
 *     100ms flusher. Bounded queue size; overflow bumps a drop counter
 *     that emits a single warning every 60s.
 *   - The flusher uses a single `openSync` + batched `writeSync` +
 *     `closeSync` per drain — far cheaper than per-entry sync write.
 *   - Per-file 50MB cap → rotate to `unified-<date>.<iso>.log`.
 *   - Per-directory 500MB cap → evict oldest files (still respects
 *     `LOG_RETENTION_DAYS=30` from logUtils.ts — they coexist, with bytes
 *     winning when both apply).
 *   - Process exit / SIGINT / SIGTERM hook drains the queue using the
 *     same batched openSync/writeSync path, so we don't lose entries at
 *     shutdown without resorting to a per-entry sync write.
 *   - Exposes `getRecentLogLines(n)` for the crash dumper to capture
 *     last-N tail lines into the crash log bundle.
 *
 * Console.* callers are unaffected: `logger.ts::createAndBroadcast` still
 * calls `appendUnifiedLog(entry)` exactly as before.
 */

import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'fs';
import { join } from 'path';

import type { LogEntry } from '../renderer/types/log';
import { LOGS_DIR, LOG_RETENTION_DAYS, ensureLogsDir } from './logUtils';
import { localDate } from '../shared/logTime';

// ── Tunables (Pattern 6 §6.3.5) ────────────────────────────────────────
const FLUSH_INTERVAL_MS = 100;
/** Hard cap on in-memory queue length. Overflow increments drop counter. */
const QUEUE_MAX_ENTRIES = 1000;
/** Per-file size cap before rotation. */
const PER_FILE_MAX_BYTES = 50 * 1024 * 1024; // 50MB
/**
 * Per-directory size cap before oldest-eviction.
 *
 * Issue #121 (2026-05): the old 500MB cap silently evicted recent unified logs
 * even though they were well within the 30-day retention window. With heavy
 * daily logging (verbose 0.2.x SDK init + IM bots + cron) it's not unusual for
 * a few days to push past 500MB; eviction then chewed through the most recent
 * days first because they happened to be the only files on disk. Result: users
 * lost the diagnostics they actually needed (last few days of activity) while
 * older files would have been the safer thing to discard.
 *
 * Bumped to 5GB so the byte cap is a true safety valve against runaway disk
 * use, not an everyday eviction trigger. Together with the MIN_RETAIN_DAYS
 * floor below, recent logs are preserved unless disk usage is extreme.
 */
const DIR_MAX_BYTES = 5 * 1024 * 1024 * 1024; // 5GB
/**
 * Files modified within this window are NEVER evicted by the byte budget,
 * even if total directory size exceeds DIR_MAX_BYTES. The age-based retention
 * pass (`cleanupOldUnifiedLogs`, 30 days) still applies on top, so files
 * outside this floor but inside retention are eligible for size eviction.
 *
 * Pit-of-success: whatever a user is debugging right now, they will not
 * lose their recent log. If the floor + age retention together can't fit
 * under DIR_MAX_BYTES, we emit a stderr warning rather than evict recent
 * data — the warning makes the budget violation auditable.
 */
const MIN_RETAIN_DAYS = 7;
/** Drop-warning emit interval (only emits if dropped > 0 since last warn). */
const DROP_WARN_INTERVAL_MS = 60_000;
/** In-memory ring buffer for crash-log tail capture. */
const RECENT_LINES_CAPACITY = 200;

// ── State ───────────────────────────────────────────────────────────────
let currentDate: string | null = null;
let currentFilePath: string | null = null;
let currentFileSize = 0;

const queue: string[] = [];
let dropped = 0;
let lastDropWarnAt = 0;

let flushTimer: ReturnType<typeof setInterval> | null = null;
let exitHookInstalled = false;

/** Tail ring buffer for crash dumps (kept separate from the flush queue). */
const recentLines: string[] = [];

// ── Date / path resolution ─────────────────────────────────────────────
function getLogFilePath(): string {
  const today = localDate();
  if (currentDate !== today) {
    currentDate = today;
    currentFilePath = join(LOGS_DIR, `unified-${today}.log`);
    // Refresh size cache on day rollover.
    try {
      currentFileSize = existsSync(currentFilePath) ? statSync(currentFilePath).size : 0;
    } catch {
      currentFileSize = 0;
    }
  }
  return currentFilePath!;
}

// ── Formatting ─────────────────────────────────────────────────────────
// Map of internal discriminant → on-disk source label. The discriminant
// `'bun'` is kept as a discriminant for backward-compat parsing of pre-0.2.0
// unified-log files (see `LogSource` type in `shared/types/log.ts`), but
// from v0.2.0 the sidecar runs on Node.js and the on-disk log line MUST say
// `[NODE ]` — both to match reality and because greps in tech_docs already
// use `[NODE ]`. (See unified log line 92 comment for the intent.)
const SOURCE_LABEL: Record<string, string> = {
  bun: 'NODE',
};

function formatLogEntry(entry: LogEntry): string {
  const level = entry.level.toUpperCase().padEnd(5);
  const labeled = SOURCE_LABEL[entry.source] ?? entry.source.toUpperCase();
  const source = labeled.padEnd(5);
  // Correlation fields are emitted as a compact bracketed suffix when
  // present — keeps existing greps for `[NODE ] [INFO ]` working while
  // making `sessionId=...` filterable. Order is fixed (sessionId → turnId
  // → requestId → tabId → runtime → ownerId) so log diffs stay stable.
  const tags: string[] = [];
  if (entry.sessionId) tags.push(`sid=${entry.sessionId}`);
  if (entry.turnId) tags.push(`turn=${entry.turnId}`);
  if (entry.requestId) tags.push(`req=${entry.requestId}`);
  if (entry.tabId) tags.push(`tab=${entry.tabId}`);
  if (entry.runtime) tags.push(`rt=${entry.runtime}`);
  if (entry.ownerId) tags.push(`owner=${entry.ownerId}`);
  const tagSuffix = tags.length ? ` [${tags.join(' ')}]` : '';
  return `${entry.timestamp} [${source}] [${level}]${tagSuffix} ${entry.message}`;
}

// ── Rotation / eviction ────────────────────────────────────────────────
function rotateIfNeeded(addBytes: number): void {
  if (!currentFilePath) return;
  if (currentFileSize + addBytes <= PER_FILE_MAX_BYTES) return;
  // Rotate: rename current to <name>.<timestamp>.log
  try {
    const ts = new Date().toISOString().replace(/[:]/g, '-');
    const dot = currentFilePath.lastIndexOf('.');
    const rotatedPath =
      dot >= 0
        ? `${currentFilePath.slice(0, dot)}.${ts}${currentFilePath.slice(dot)}`
        : `${currentFilePath}.${ts}`;
    renameSync(currentFilePath, rotatedPath);
  } catch {
    // If rotation fails, fall through — we'll keep appending.
  }
  currentFileSize = 0;
}

function enforceDirectoryBudget(): void {
  try {
    const files = readdirSync(LOGS_DIR)
      .filter((f) => f.startsWith('unified-') && f.endsWith('.log'))
      .map((f) => {
        const p = join(LOGS_DIR, f);
        try {
          const s = statSync(p);
          return { path: p, mtimeMs: s.mtimeMs, size: s.size };
        } catch {
          return null;
        }
      })
      .filter((x): x is { path: string; mtimeMs: number; size: number } => x !== null);

    let total = files.reduce((acc, f) => acc + f.size, 0);
    if (total <= DIR_MAX_BYTES) return;

    // Issue #121: never evict files modified within MIN_RETAIN_DAYS — recent
    // logs are what users need for active debugging, and the byte budget is
    // a safety valve, not an everyday tool.
    const floorCutoff = Date.now() - MIN_RETAIN_DAYS * 24 * 60 * 60 * 1000;
    files.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first

    const evicted: string[] = [];
    for (const f of files) {
      if (total <= DIR_MAX_BYTES) break;
      // Don't evict the actively-writing file even if it's oldest by mtime
      // (race: we just rotated and renamed it — defensive).
      if (f.path === currentFilePath) continue;
      // Floor: skip files inside the protected recent window.
      if (f.mtimeMs >= floorCutoff) continue;
      try {
        unlinkSync(f.path);
        total -= f.size;
        evicted.push(f.path);
      } catch {
        // Ignore individual eviction errors.
      }
    }

    // Make eviction auditable — without this, users see "all my April logs
    // are gone" with no record of when or why (#121's exact symptom). Use
    // stderr directly: writing back through appendUnifiedLog could recurse
    // into another budget check at a bad time.
    if (evicted.length > 0) {
      try {
        process.stderr.write(
          `[UnifiedLogger] evicted ${evicted.length} old log file(s) to enforce ${DIR_MAX_BYTES / (1024 * 1024 * 1024)}GB budget: ${evicted.map(p => p.split('/').pop()).join(', ')}\n`,
        );
      } catch { /* ignore */ }
    } else if (total > DIR_MAX_BYTES) {
      // All remaining files are within the protected window — we cannot
      // bring usage under budget without violating the floor. Warn instead
      // of silently failing.
      try {
        process.stderr.write(
          `[UnifiedLogger] WARNING: log directory ${(total / (1024 * 1024 * 1024)).toFixed(2)}GB exceeds ${DIR_MAX_BYTES / (1024 * 1024 * 1024)}GB budget but all files are within ${MIN_RETAIN_DAYS}-day retention floor; not evicting\n`,
        );
      } catch { /* ignore */ }
    }
  } catch {
    // Ignore directory walk errors — best-effort budget enforcement.
  }
}

// ── Flusher ────────────────────────────────────────────────────────────
function rememberRecent(line: string): void {
  recentLines.push(line);
  if (recentLines.length > RECENT_LINES_CAPACITY) {
    recentLines.splice(0, recentLines.length - RECENT_LINES_CAPACITY);
  }
}

function flushNow(): void {
  if (queue.length === 0) return;
  // Drain the queue atomically — new pushes during write go to a fresh queue.
  let lines: string[] = queue.splice(0, queue.length);
  const payload = lines.join('');
  // payload is already newline-terminated per-line.
  try {
    ensureLogsDir();
    const filePath = getLogFilePath();
    rotateIfNeeded(payload.length);
    // Use a single open/write/close per flush — far cheaper than per-entry
    // sync writes because we batch up to 1000 entries.
    const fd = openSync(filePath, 'a');
    try {
      writeSync(fd, payload);
    } finally {
      closeSync(fd);
    }
    currentFileSize += payload.length;
  } catch {
    // Re-queue on failure? No — that risks unbounded growth if the disk is
    // dead. Drop instead and let the warn timer surface it.
    dropped += lines.length;
    lines = [];
  }
  // Lazy directory-budget enforcement (only when we just wrote a lot).
  if (payload.length > 0 && currentFileSize >= PER_FILE_MAX_BYTES) {
    enforceDirectoryBudget();
  }
}

function maybeWarnDrop(): void {
  if (dropped <= 0) return;
  const now = Date.now();
  if (now - lastDropWarnAt < DROP_WARN_INTERVAL_MS) return;
  lastDropWarnAt = now;
  // Use stderr directly so the warning itself can't recurse into the queue.
  try {
    process.stderr.write(`[UnifiedLogger] dropped ${dropped} log entries (queue saturated)\n`);
  } catch { /* ignore */ }
  dropped = 0;
}

function ensureFlusher(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    flushNow();
    maybeWarnDrop();
  }, FLUSH_INTERVAL_MS);
  // Don't keep the event loop alive solely for the flusher.
  if (typeof flushTimer === 'object' && flushTimer && 'unref' in flushTimer) {
    (flushTimer as { unref?: () => void }).unref?.();
  }
  installExitHooks();
}

function installExitHooks(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  const drain = () => {
    try {
      if (queue.length === 0) return;
      // Same batched open/write/close as the regular flusher path, just
      // run synchronously now because the process is exiting.
      const payload = queue.splice(0, queue.length).join('');
      ensureLogsDir();
      const fd = openSync(getLogFilePath(), 'a');
      try {
        writeSync(fd, payload);
      } finally {
        closeSync(fd);
      }
    } catch { /* best effort */ }
  };
  process.on('exit', drain);
  process.on('beforeExit', drain);
  process.once('SIGINT', () => { drain(); });
  process.once('SIGTERM', () => { drain(); });
}

// ── Public API (unchanged signatures) ──────────────────────────────────

/**
 * Clean up old unified log files (older than LOG_RETENTION_DAYS).
 * Coexists with byte-budget eviction in the flusher path.
 */
export function cleanupOldUnifiedLogs(): void {
  ensureLogsDir();

  const now = Date.now();
  const maxAge = LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let deletedCount = 0;

  try {
    const files = readdirSync(LOGS_DIR);
    for (const file of files) {
      if (!file.startsWith('unified-') || !file.endsWith('.log')) continue;
      const filePath = join(LOGS_DIR, file);
      try {
        const stat = statSync(filePath);
        const age = now - stat.mtimeMs;
        if (age > maxAge) {
          unlinkSync(filePath);
          deletedCount++;
        }
      } catch { /* ignore */ }
    }
    if (deletedCount > 0) {
      console.log(`[UnifiedLogger] Cleaned up ${deletedCount} old unified log files`);
    }
  } catch (err) {
    console.error('[UnifiedLogger] Failed to cleanup old logs:', err);
  }
  // Also enforce byte budget at startup so a stale 600MB dir gets trimmed.
  enforceDirectoryBudget();
}

/**
 * Append a log entry — non-blocking. Enqueues to an in-memory buffer
 * drained by the 100ms flusher. Drops on overflow with a counter.
 */
export function appendUnifiedLog(entry: LogEntry): void {
  const line = formatLogEntry(entry) + '\n';
  rememberRecent(line);
  if (queue.length >= QUEUE_MAX_ENTRIES) {
    dropped++;
    return;
  }
  queue.push(line);
  ensureFlusher();
}

/**
 * Append multiple log entries (batch enqueue). Same overflow semantics.
 */
export function appendUnifiedLogBatch(entries: LogEntry[]): void {
  if (entries.length === 0) return;
  for (const entry of entries) {
    const line = formatLogEntry(entry) + '\n';
    rememberRecent(line);
    if (queue.length >= QUEUE_MAX_ENTRIES) {
      dropped++;
      continue;
    }
    queue.push(line);
  }
  ensureFlusher();
}

/**
 * Internal-test hook: drain the queue synchronously. Tests use this to
 * avoid waiting on the 100ms timer.
 */
export function _flushUnifiedLogForTests(): void {
  flushNow();
}

/**
 * Drop counter accessor for tests / diagnostics. Resets to 0 once read by
 * the warn timer; tests should call before that fires.
 */
export function _getDroppedCount(): number {
  return dropped;
}

/**
 * Last-N tail lines (already newline-terminated). Used by the crash dumper
 * (`index.ts::writeCrashLog`) to embed recent unified context in the crash
 * bundle. Capacity is fixed at RECENT_LINES_CAPACITY.
 */
export function getRecentLogLines(n: number = RECENT_LINES_CAPACITY): string[] {
  if (n >= recentLines.length) return recentLines.slice();
  return recentLines.slice(recentLines.length - n);
}
