/**
 * Run-scoped sandbox for the whole suite (vitest globalSetup).
 *
 * Every test file, fork worker and spawned hook/server inherits TMPDIR and
 * HOME pointing inside one fresh directory, which teardown deletes. Tests
 * that forget to clean up their mkdtemp dirs, SQLite -wal/-shm sidecars or
 * tmpdir() markers therefore leave nothing behind, and no test can write
 * into the developer's real ~/.claude/context-mode session/content stores.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default function setup() {
  const root = mkdtempSync(join(tmpdir(), "context-mode-vitest-"));
  const tmp = join(root, "tmp");
  const home = join(root, "home");
  mkdirSync(tmp);
  mkdirSync(home);

  const saved = {
    TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP,
    HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
  };
  process.env.CONTEXT_MODE_TEST_REAL_HOME = saved.HOME ?? "";
  // Toolchains that locate themselves via HOME (rustup, cargo) must keep
  // finding the real install, or the polyglot executor tests cannot compile.
  const realHome = saved.HOME;
  const pinned: Record<string, string | undefined> = {};
  for (const [k, sub] of [["RUSTUP_HOME", ".rustup"], ["CARGO_HOME", ".cargo"]] as const) {
    pinned[k] = process.env[k];
    if (!process.env[k] && realHome && existsSync(join(realHome, sub))) {
      process.env[k] = join(realHome, sub);
    }
  }
  process.env.TMPDIR = process.env.TMP = process.env.TEMP = tmp;
  process.env.HOME = process.env.USERPROFILE = home;

  return () => {
    for (const [k, v] of Object.entries({ ...saved, ...pinned })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  };
}
