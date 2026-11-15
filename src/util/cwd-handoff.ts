/**
 * Server side of the PreToolUse → MCP cwd handoff. See hooks/core/cwd-handoff.mjs
 * for why the hook no longer rewrites tool input. handoffKey() must stay
 * byte-identical to the hook's version (tests/util/cwd-handoff.test.ts checks).
 */

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const HANDOFF_TTL_MS = 120_000;

// Per-user, never shared /tmp (see hooks/core/cwd-handoff.mjs).
export function handoffDir(): string {
  return join(homedir(), ".cache", "context-mode", "cwd-handoff");
}

function ownedByMe(st: { uid: number }): boolean {
  return typeof process.getuid !== "function" || st.uid === process.getuid();
}

export function handoffKey(
  kind: "execute" | "batch",
  input: { language?: string; code?: unknown; commands?: unknown },
): string | null {
  let material: string;
  if (kind === "execute") {
    if (typeof input.code !== "string") return null;
    material = `execute\0${input.language ?? ""}\0${input.code}`;
  } else {
    let arr = input.commands;
    if (typeof arr === "string") {
      try { arr = JSON.parse(arr); } catch { return null; }
    }
    if (!Array.isArray(arr)) return null;
    const cmds = arr.map((c) =>
      typeof c === "string" ? c : String((c as { command?: unknown })?.command ?? ""),
    );
    material = `batch\0${JSON.stringify(cmds)}`;
  }
  return createHash("sha256").update(material).digest("hex");
}

/**
 * Return (and delete) the cwd the hook recorded for this exact call, if it is
 * fresh and still a directory. Never throws.
 */
export function consumeCwdHandoff(
  kind: "execute" | "batch",
  input: { language?: string; code?: unknown; commands?: unknown },
  now: number = Date.now(),
  dir: string = handoffDir(),
): string | undefined {
  try {
    const key = handoffKey(kind, input);
    if (!key) return undefined;
    const dst = lstatSync(dir);
    if (!dst.isDirectory() || !ownedByMe(dst)) return undefined;
    if (process.platform !== "win32" && (dst.mode & 0o077)) return undefined;
    const p = join(dir, key);
    const fst = lstatSync(p);
    if (!fst.isFile() || !ownedByMe(fst)) return undefined;
    const raw = readFileSync(p, "utf-8");
    try { unlinkSync(p); } catch { /* another server consumed it */ }
    const { cwd, at } = JSON.parse(raw) as { cwd?: unknown; at?: unknown };
    if (typeof cwd !== "string" || typeof at !== "number") return undefined;
    if (at > now + 5_000 || now - at > HANDOFF_TTL_MS) return undefined;
    if (!statSync(cwd).isDirectory()) return undefined;
    return cwd;
  } catch {
    return undefined;
  }
}
