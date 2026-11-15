/**
 * Out-of-band cwd handoff from the Claude Code PreToolUse hook to the MCP server.
 *
 * The hook knows the session's real cwd (hook input `cwd`); the MCP server
 * often does not (CLAUDE_PROJECT_DIR is stale or absent in its env — #756).
 * The hook used to pin it by rewriting the tool input (`updatedInput.cwd`),
 * but Claude Code's auto-mode classifier refuses any call whose input a hook
 * changed ("a hook changed this call's input after auto mode reviewed it"),
 * and the refusal also spreads to sibling calls in the same response.
 *
 * Instead the hook drops a small file keyed by a hash of the call's code and
 * the server consumes it when the same code arrives. The tool input is never
 * modified. src/util/cwd-handoff.ts mirrors handoffKey() — keep them identical.
 */

import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HANDOFF_TTL_MS = 120_000;

// Per-user location, never shared /tmp: a file planted there by another
// local user would choose the cwd our shell commands run in.
export function handoffDir() {
  return join(homedir(), ".cache", "context-mode", "cwd-handoff");
}

/** Create the dir 0700 and refuse it unless it is a real dir we own. */
function ensurePrivateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory()) throw new Error("handoff dir is not a directory");
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    throw new Error("handoff dir not owned by current user");
  }
  if (process.platform !== "win32" && (st.mode & 0o077)) chmodSync(dir, 0o700);
}

function commandStrings(commands) {
  let arr = commands;
  if (typeof arr === "string") {
    try { arr = JSON.parse(arr); } catch { return null; }
  }
  if (!Array.isArray(arr)) return null;
  return arr.map((c) => (typeof c === "string" ? c : String(c?.command ?? "")));
}

/**
 * @param {"execute" | "batch"} kind
 * @param {object} toolInput
 * @returns {string | null} hex key, or null when the input has nothing to key on
 */
export function handoffKey(kind, toolInput) {
  let material;
  if (kind === "execute") {
    if (typeof toolInput?.code !== "string") return null;
    material = `execute\0${toolInput.language ?? ""}\0${toolInput.code}`;
  } else {
    const cmds = commandStrings(toolInput?.commands);
    if (!cmds) return null;
    material = `batch\0${JSON.stringify(cmds)}`;
  }
  return createHash("sha256").update(material).digest("hex");
}

/** Best effort: never throws. */
export function writeCwdHandoff(kind, toolInput, cwd) {
  try {
    const key = handoffKey(kind, toolInput);
    if (!key || typeof cwd !== "string" || !cwd) return;
    const dir = handoffDir();
    ensurePrivateDir(dir);
    // Exclusive-create a temp name, then rename: never follows a planted link.
    const tmp = join(dir, `.${key}.${process.pid}.${Date.now()}`);
    writeFileSync(tmp, JSON.stringify({ cwd, at: Date.now() }), { mode: 0o600, flag: "wx" });
    renameSync(tmp, join(dir, key));
    // Sweep entries the server never consumed (call denied, server down).
    const now = Date.now();
    for (const f of readdirSync(dir)) {
      try {
        const p = join(dir, f);
        if (now - lstatSync(p).mtimeMs > HANDOFF_TTL_MS) unlinkSync(p);
      } catch { /* raced with another sweeper */ }
    }
  } catch { /* handoff is an optimisation; server falls back to its own resolver */ }
}
