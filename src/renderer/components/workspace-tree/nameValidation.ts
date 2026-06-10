/**
 * Renderer mirror of Rust `path_safety::validate_item_name` — gives the
 * inline create/rename editor LIVE feedback so users never hit a Rust error
 * round-trip for a name the UI could have rejected. Rust remains the
 * authority; this must stay rule-for-rule in sync (both files reference each
 * other).
 *
 * Returns a user-facing Chinese message, or `null` when the name is valid.
 */
export function validateItemName(name: string): string | null {
  if (name.length === 0 || name.trim().length === 0) {
    return "名称不能为空";
  }
  if (name !== name.trim()) {
    return "名称不能以空格开头或结尾";
  }
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    return "名称不能包含路径分隔符或 '..'";
  }
  if (/[<>:"|?*]/.test(name)) {
    return "名称包含非法字符 < > : \" | ? *";
  }
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return "名称包含控制字符";
    }
  }
  if ([...name].every((c) => c === ".")) {
    return "名称不能只由点组成";
  }
  if (isWindowsReservedName(name)) {
    return `'${name}' 是 Windows 保留文件名`;
  }
  return null;
}

const WINDOWS_RESERVED = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

function isWindowsReservedName(name: string): boolean {
  // Windows strips trailing dots/spaces during normalization, so `CON.`,
  // `CON ` all resolve to the device `CON` — same stem treatment as Rust.
  const dotIdx = name.indexOf(".");
  const stemRaw = dotIdx >= 0 ? name.slice(0, dotIdx) : name;
  const stem = stemRaw.replace(/[ .]+$/, "").toUpperCase();
  return WINDOWS_RESERVED.has(stem);
}
