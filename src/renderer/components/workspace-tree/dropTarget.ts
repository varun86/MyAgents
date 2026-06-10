import type { WorkspaceTreeNodeMeta } from "./treeTypes";

/**
 * Droppable id of the viewport-wide root zone: the `drop:` prefix with an
 * empty path (= the workspace root). Registered on the wrapper around the
 * whole tree viewport so dropping on blank space below the last row targets
 * the root — and so `over === null` can mean what it should mean: "pointer
 * left the tree entirely, don't drop anywhere".
 */
export const ROOT_DROP_ID = "drop:";

/** Extract the workspace-relative path from a `drop:<path>` droppable id. */
export function parseDropId(overId: string | null): string | null {
  if (overId === null) return null;
  if (!overId.startsWith("drop:")) return null;
  return overId.slice("drop:".length);
}

function parentDirOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx > 0 ? path.slice(0, idx) : "";
}

/**
 * Resolve the EFFECTIVE target directory of an internal tree drag, VS Code
 * style. Pure — the component feeds it `event.over.id` and the current node
 * meta map; the result drives both the highlight and the eventual move.
 *
 * Rules:
 *  - `null` over id (pointer outside the tree)            → null (no drop)
 *  - root zone id                                          → "" (workspace root)
 *  - over a directory row                                  → that directory
 *  - over a FILE row                                       → the file's parent
 *    directory (dropping "on a file" means "into where that file lives" —
 *    pre-fix this fell through to the root and silently moved items there)
 *  - over a row that no longer exists in the tree          → null
 *  - target is one of the sources / inside a dragged dir   → null
 *  - every dragged item already sits directly in target    → null (no-op —
 *    suppressing it here also suppresses the misleading highlight)
 */
export function resolveInternalDropTarget(
  overId: string | null,
  sourcePaths: readonly string[],
  nodeMetaByPath: ReadonlyMap<string, WorkspaceTreeNodeMeta>,
): string | null {
  const overPath = parseDropId(overId);
  if (overPath === null) return null;

  let targetDir: string;
  if (overPath === "") {
    targetDir = "";
  } else {
    const meta = nodeMetaByPath.get(overPath);
    if (!meta) return null;
    targetDir =
      meta.data.type === "dir" ? overPath : (meta.parentPath ?? "");
  }

  for (const src of sourcePaths) {
    if (src === targetDir) return null;
    if (targetDir.startsWith(`${src}/`)) return null;
  }
  if (
    sourcePaths.length > 0 &&
    sourcePaths.every((p) => parentDirOf(p) === targetDir)
  ) {
    return null;
  }
  return targetDir;
}
