/**
 * Plan-mode hard gate (issue #295) — pure decision core.
 *
 * WHY THIS EXISTS
 * ---------------
 * MyAgents launches the Claude Agent SDK subprocess with
 * `allowDangerouslySkipPermissions: true` (so a mid-session switch to
 * fullAgency / `bypassPermissions` is honored without a restart — see the
 * comment at the `query()` options in agent-session.ts). At spawn time the SDK
 * translates that flag into the CLI arg `--allow-dangerously-skip-permissions`,
 * which sets the native CLI's `toolPermissionContext.isBypassPermissionsModeAvailable = true`.
 *
 * The native permission resolver then short-circuits:
 *
 *     // (decompiled from the bundled `claude` binary)
 *     function resolve(mode, isBypassAvailable) {
 *       if (mode === "auto") return "classify";
 *       if (mode === "bypassPermissions" || (mode === "plan" && isBypassAvailable)) return "allow";
 *       if (mode === "dontAsk") return "deny";
 *       return "ask"; // <- only "ask" sends a can_use_tool control_request to our canUseTool
 *     }
 *
 * So whenever bypass mode is "available", **plan mode resolves every ordinary
 * tool to "allow"** — the CLI never emits a `can_use_tool` control request, our
 * `canUseTool` callback (where MyAgents enforces the plan-mode read-only rules)
 * is NEVER invoked, and `result.permission_denials` stays empty. A well-behaved
 * Claude model honors the plan-mode system reminder ("you MUST NOT run any
 * non-readonly tools") and only calls ExitPlanMode, so the missing enforcement
 * is invisible. A weaker third-party model ignores the reminder and calls
 * `Bash rm -rf …` / `Edit` directly — and they execute unchecked (#295).
 *
 * THE FIX
 * -------
 * PreToolUse hooks run BEFORE the native permission resolver, and a hook
 * `permissionDecision: 'deny'` is honored regardless of the bypass-availability
 * short-circuit (`PreToolUse hook denies bypass canUseTool` per the SDK docs).
 * So a PreToolUse hook is the one place that can restore plan mode's read-only
 * guarantee WITHOUT giving up the always-on flag that fullAgency needs. Because
 * the hook reads the live permission mode on every tool call, it covers EVERY
 * way plan mode can be entered: agent config, the UI toggle, AND the AI's own
 * `EnterPlanMode` mid-turn (none of which a spawn-time flag could retro-fix on
 * the already-running subprocess).
 *
 * This module is the pure decision function (no I/O) so it can be unit-tested in
 * the fast pool; the imperative shell (the registered hook, logging) lives in
 * agent-session.ts. The allowlist is the single source of truth shared with
 * `getPermissionRules('plan')` so the canUseTool path and this hook can never
 * drift apart.
 */

/**
 * Tools auto-allowed in plan mode: read-only file/codebase inspection only.
 * Mirrors `getPermissionRules('plan').allowedTools` (agent-session.ts consumes
 * this same constant so the two stay in lockstep).
 */
export const PLAN_MODE_READONLY_TOOLS = ['Read', 'Glob', 'Grep', 'LS'] as const;

/**
 * Control-transfer tools that MUST reach the host (never auto-denied): the user
 * approves the plan / answers questions through these. The SDK always routes
 * `requiresUserInteraction` tools to the host even under the bypass shortcut, so
 * leaving them un-blocked here lets canUseTool's interactive handlers run.
 * Mirrors the `USER_INTERACTION_TOOLS` set in agent-session.ts's canUseTool.
 */
export const PLAN_MODE_HOST_INTERACTION_TOOLS = ['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode'] as const;

/**
 * Decide whether a PreToolUse hook should DENY a tool because the session is in
 * plan mode.
 *
 * Returns `true` (block) for any tool that is neither a plan-mode read-only tool
 * nor a control-transfer tool — i.e. every write / side-effecting tool (Bash,
 * Edit, Write, MultiEdit, NotebookEdit, Task, WebFetch, WebSearch, Skill, all
 * `mcp__*` tools, the `myagents` CLI, …). Returns `false` (allow normal flow)
 * when not in plan mode, for the read-only allowlist, and for control-transfer
 * tools.
 *
 * `mode` is typed as `string` so this leaf module carries no dependency on
 * agent-session.ts's `PermissionMode` union; only the `'plan'` literal matters.
 */
export function shouldBlockToolInPlanMode(toolName: string, mode: string): boolean {
  if (mode !== 'plan') return false;
  if ((PLAN_MODE_HOST_INTERACTION_TOOLS as readonly string[]).includes(toolName)) return false;
  if ((PLAN_MODE_READONLY_TOOLS as readonly string[]).includes(toolName)) return false;
  return true;
}

/** Human-facing denial message routed back to the model via the hook's deny reason. */
export function planModeDenyMessage(toolName: string): string {
  return (
    `当前处于 Plan（规划）模式，禁止执行写操作或有副作用的工具（本次被拦截：${toolName}）。` +
    `请先完成调研与规划，再用 ExitPlanMode 工具提交方案供用户审批；获批退出 Plan 模式后才能执行写操作。`
  );
}
