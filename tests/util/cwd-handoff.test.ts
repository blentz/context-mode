import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handoffKey as serverKey,
  handoffDir,
  consumeCwdHandoff,
  HANDOFF_TTL_MS,
} from "../../src/util/cwd-handoff.js";
// @ts-expect-error — plain .mjs hook module
import { handoffKey as hookKey, writeCwdHandoff } from "../../hooks/core/cwd-handoff.mjs";

describe("cwd handoff (hook → MCP server)", () => {
  const cases: Array<["execute" | "batch", Record<string, unknown>]> = [
    ["execute", { language: "shell", code: "pwd" }],
    ["execute", { language: "shell", code: "echo 'ü\nmulti'\n" }],
    ["batch", { commands: [{ label: "a", command: "ls" }, { label: "b", command: "git status" }] }],
    ["batch", { commands: ["ls", "git status"] }],
    ["batch", { commands: JSON.stringify([{ label: "a", command: "ls" }]) }],
  ];

  it.each(cases)("hook and server derive the same key (%s)", (kind, input) => {
    expect(serverKey(kind, input)).toBe(hookKey(kind, input));
    expect(serverKey(kind, input)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("labels and string/object command forms do not change the batch key", () => {
    // The server's zod preprocessor turns bare strings into {label, command}.
    expect(serverKey("batch", { commands: ["ls"] })).toBe(
      serverKey("batch", { commands: [{ label: "cmd_1", command: "ls" }] }),
    );
  });

  it("round-trips once, then is gone", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-handoff-"));
    try {
      const input = { language: "shell", code: `pwd # ${dir}` };
      writeCwdHandoff("execute", input, dir);
      expect(consumeCwdHandoff("execute", input)).toBe(dir);
      expect(consumeCwdHandoff("execute", input)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores stale entries and directories that no longer exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-handoff-"));
    const a = { language: "shell", code: `stale ${dir}` };
    writeCwdHandoff("execute", a, dir);
    expect(consumeCwdHandoff("execute", a, Date.now() + HANDOFF_TTL_MS + 1)).toBeUndefined();

    const b = { language: "shell", code: `gone ${dir}` };
    writeCwdHandoff("execute", b, dir);
    rmSync(dir, { recursive: true, force: true });
    expect(consumeCwdHandoff("execute", b)).toBeUndefined();
  });

  it("keeps the handoff dir private to the user", () => {
    writeCwdHandoff("execute", { language: "shell", code: "mode-check" }, tmpdir());
    expect(statSync(handoffDir()).mode & 0o077).toBe(0);
    consumeCwdHandoff("execute", { language: "shell", code: "mode-check" });
  });

  it("rejects a symlinked entry and a timestamp from the future", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctx-handoff-"));
    try {
      const a = { language: "shell", code: `link ${dir}` };
      writeCwdHandoff("execute", { language: "shell", code: "seed" }, dir); // ensure dir exists
      consumeCwdHandoff("execute", { language: "shell", code: "seed" });
      const target = join(dir, "payload.json");
      writeFileSync(target, JSON.stringify({ cwd: dir, at: Date.now() }));
      const planted = join(handoffDir(), serverKey("execute", a)!);
      symlinkSync(target, planted);
      try {
        expect(consumeCwdHandoff("execute", a)).toBeUndefined();
      } finally {
        unlinkSync(planted);
      }

      const b = { language: "shell", code: `future ${dir}` };
      writeCwdHandoff("execute", b, dir);
      expect(consumeCwdHandoff("execute", b, Date.now() - 60_000)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
