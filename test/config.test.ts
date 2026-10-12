import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_BASE_URL, DEFAULT_SERVER_MODULE, DEFAULT_TIMEOUT_MS, DEFAULT_STARTUP_TIMEOUT_MS, findExecutable, isLoopback, normalizeBaseUrl, readSettings, resolveServerLaunch, serverEntrySpecifier } from "../src/config.ts";

const dirs: string[] = [];
function temp(): string { const dir = mkdtempSync(join(tmpdir(), "mcp-config-")); dirs.push(dir); return dir; }
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

describe("MCP proxy settings", () => {
  it("defaults to loopback, autostart, and a long timeout", () => {
    expect(readSettings({})).toEqual({
      baseUrl: DEFAULT_BASE_URL, timeoutMs: DEFAULT_TIMEOUT_MS, autoStart: true,
      serverEntry: null, configPath: null, startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
    });
  });

  it("accepts environment overrides", () => {
    expect(readSettings({
      HARNESS_ACP_BRIDGE_URL: "http://127.0.0.1:9000/", HARNESS_ACP_BRIDGE_TIMEOUT_MS: "15000",
      HARNESS_ACP_BRIDGE_AUTOSTART: "0", HARNESS_ACP_BRIDGE_CONFIG: "/cfg.yaml",
      HARNESS_ACP_BRIDGE_SERVER_ENTRY: "./server.js", HARNESS_ACP_BRIDGE_STARTUP_TIMEOUT_MS: "5000",
    })).toEqual({
      baseUrl: "http://127.0.0.1:9000", timeoutMs: 15000, autoStart: false,
      configPath: "/cfg.yaml", serverEntry: "./server.js", startupTimeoutMs: 5000,
    });
  });

  it("reads a JSON settings file and lets the environment win", () => {
    const dir = temp();
    const path = join(dir, "settings.json");
    writeFileSync(path, JSON.stringify({ baseUrl: "https://bridge.example/base", timeoutMs: 5000, autoStart: false, serverEntry: "pkg" }));
    expect(readSettings({ HARNESS_ACP_BRIDGE_MCP_CONFIG: path })).toEqual({
      baseUrl: "https://bridge.example/base", timeoutMs: 5000, autoStart: false, serverEntry: "pkg", configPath: null, startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
    });
    expect(readSettings({ HARNESS_ACP_BRIDGE_MCP_CONFIG: path, HARNESS_ACP_BRIDGE_URL: "http://127.0.0.1:1" }).baseUrl).toBe("http://127.0.0.1:1");
  });

  it("resolves a relative server config against the given cwd", () => {
    const dir = temp();
    const path = join(dir, "settings.json");
    writeFileSync(path, JSON.stringify({ configPath: "rel/config.yaml" }));
    expect(readSettings({ HARNESS_ACP_BRIDGE_MCP_CONFIG: path }, dir).configPath).toBe(join(dir, "rel/config.yaml"));
    expect(readSettings({ HARNESS_ACP_BRIDGE_CONFIG: "cfg.yaml" }, dir).configPath).toBe(join(dir, "cfg.yaml"));
    expect(readSettings({ HARNESS_ACP_BRIDGE_CONFIG: "/abs/cfg.yaml" }, dir).configPath).toBe("/abs/cfg.yaml");
  });

  it("normalizes server entries to file URLs without re-wrapping file: URLs", () => {
    const cwd = "/base";
    expect(serverEntrySpecifier("@scope/pkg", cwd)).toBeNull();
    expect(serverEntrySpecifier("./server.js", cwd)).toBe(pathToFileURL("/base/server.js").href);
    expect(serverEntrySpecifier("../server.js", cwd)).toBe(pathToFileURL("/server.js").href);
    expect(serverEntrySpecifier("/abs/server.js", cwd)).toBe(pathToFileURL("/abs/server.js").href);
    expect(serverEntrySpecifier("file:///abs/server.js", cwd)).toBe("file:///abs/server.js");
  });

  it("classifies loopback addresses", () => {
    for (const url of ["http://127.0.0.1:8787", "http://localhost:8787", "http://[::1]:8787", "http://0.0.0.0:8787"]) {
      expect(isLoopback(url)).toBe(true);
    }
    for (const url of ["http://192.168.1.5:8787", "https://bridge.example.com", "http://10.0.0.1:1"]) {
      expect(isLoopback(url)).toBe(false);
    }
  });

  it.each(["ftp://host", "http://user:pass@host", "http://host/path?q=1", "http://host/path#f", "not-a-url"])("rejects unsafe base URLs: %s", bad => {
    expect(() => normalizeBaseUrl(bad, "settings")).toThrow();
  });

  it("rejects unknown file keys, bad JSON, and invalid timeouts", () => {
    const dir = temp();
    const unknown = join(dir, "unknown.json");
    writeFileSync(unknown, JSON.stringify({ command: "node" }));
    expect(() => readSettings({ HARNESS_ACP_BRIDGE_MCP_CONFIG: unknown })).toThrow(/unknown setting/);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{not json");
    expect(() => readSettings({ HARNESS_ACP_BRIDGE_MCP_CONFIG: bad })).toThrow(/invalid JSON/);
    expect(() => readSettings({ HARNESS_ACP_BRIDGE_TIMEOUT_MS: "0" })).toThrow();
    expect(() => readSettings({ HARNESS_ACP_BRIDGE_AUTOSTART: "maybe" })).toThrow();
  });

  it("does not validate a JSON value that a valid environment value shadows", () => {
    const dir = temp();
    const path = join(dir, "settings.json");
    writeFileSync(path, JSON.stringify({ baseUrl: "ftp://bad", timeoutMs: "nope", autoStart: "maybe", serverEntry: 5, configPath: 7 }));
    expect(readSettings({
      HARNESS_ACP_BRIDGE_MCP_CONFIG: path,
      HARNESS_ACP_BRIDGE_URL: "http://127.0.0.1:9000",
      HARNESS_ACP_BRIDGE_TIMEOUT_MS: "500",
      HARNESS_ACP_BRIDGE_AUTOSTART: "0",
      HARNESS_ACP_BRIDGE_SERVER_ENTRY: "pkg",
      HARNESS_ACP_BRIDGE_CONFIG: "c.yaml",
    }, dir)).toEqual({
      baseUrl: "http://127.0.0.1:9000", timeoutMs: 500, autoStart: false,
      serverEntry: "pkg", configPath: join(dir, "c.yaml"), startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
    });
  });

  it("rejects a JSON null where an integer timeout is required, and null optional fields clear/default", () => {
    const dir = temp();
    for (const bad of [{ timeoutMs: null }, { startupTimeoutMs: null }]) {
      const path = join(dir, "n.json");
      writeFileSync(path, JSON.stringify(bad));
      expect(() => readSettings({ HARNESS_ACP_BRIDGE_MCP_CONFIG: path })).toThrow();
    }
    const ok = join(dir, "ok.json");
    writeFileSync(ok, JSON.stringify({ autoStart: null, serverEntry: null, configPath: null }));
    expect(readSettings({ HARNESS_ACP_BRIDGE_MCP_CONFIG: ok }, dir)).toMatchObject({ autoStart: true, serverEntry: null, configPath: null });
  });

  it("accepts a valid environment value that shadows a JSON null timeout", () => {
    const dir = temp();
    const path = join(dir, "settings.json");
    writeFileSync(path, JSON.stringify({ timeoutMs: null, startupTimeoutMs: null }));
    expect(readSettings({
      HARNESS_ACP_BRIDGE_MCP_CONFIG: path, HARNESS_ACP_BRIDGE_TIMEOUT_MS: "1234", HARNESS_ACP_BRIDGE_STARTUP_TIMEOUT_MS: "4321",
    })).toMatchObject({ timeoutMs: 1234, startupTimeoutMs: 4321 });
  });
});

describe("PATH command discovery and entry selection", () => {
  it("finds an executable regular file, following symlinks, normalizing relative/empty PATH entries", () => {
    const dir = temp();
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const target = join(dir, "hacpd-real.js");
    writeFileSync(target, "#!/usr/bin/env node\n");
    chmodSync(target, 0o755);
    symlinkSync(target, join(bin, "hacpd"));

    // A relative PATH entry is resolved against the client cwd, not the supervisor's.
    expect(findExecutable("hacpd", { PATH: "bin" }, dir)).toBe(realpathSync(target));
    // An empty PATH entry means the cwd (POSIX).
    const inCwd = temp();
    writeFileSync(join(inCwd, "hacpd"), "#!/usr/bin/env node\n", { mode: 0o755 });
    expect(findExecutable("hacpd", { PATH: `:/does-not-exist` }, inCwd)).toBe(realpathSync(join(inCwd, "hacpd")));
  });

  it("skips directories, non-executable files, missing entries, and names absent everywhere", () => {
    const dir = temp();
    mkdirSync(join(dir, "asdir", "hacpd"), { recursive: true });
    expect(findExecutable("hacpd", { PATH: join(dir, "asdir") }, dir)).toBeNull();
    mkdirSync(join(dir, "plain"));
    writeFileSync(join(dir, "plain", "hacpd"), "not executable\n", { mode: 0o644 });
    expect(findExecutable("hacpd", { PATH: join(dir, "plain") }, dir)).toBeNull();
    expect(findExecutable("hacpd", { PATH: join(dir, "missing") }, dir)).toBeNull();
    expect(findExecutable("definitely-absent-xyz", { PATH: dir }, dir)).toBeNull();
  });

  it("selects explicit serverEntry > PATH hacpd > installed module, and never probes behind an explicit entry", () => {
    const dir = temp();
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const target = join(dir, "cli.js");
    writeFileSync(target, "#!/usr/bin/env node\n");
    chmodSync(target, 0o755);
    symlinkSync(target, join(bin, "hacpd"));

    expect(resolveServerLaunch({ serverEntry: "@scope/pkg" }, { PATH: bin }, dir)).toEqual({ kind: "module", specifier: "@scope/pkg" });
    expect(resolveServerLaunch({ serverEntry: "./s.js" }, { PATH: bin }, dir)).toEqual({ kind: "module", specifier: pathToFileURL(join(dir, "s.js")).href });
    expect(resolveServerLaunch({ serverEntry: null }, { PATH: bin }, dir)).toEqual({ kind: "command", command: realpathSync(target) });
    expect(resolveServerLaunch({ serverEntry: null }, { PATH: join(dir, "nope") }, dir)).toEqual({ kind: "module", specifier: DEFAULT_SERVER_MODULE });
  });

  it("treats a missing PATH as no probe, but an explicit empty PATH as the cwd", () => {
    const dir = temp();
    writeFileSync(join(dir, "hacpd"), "#!/usr/bin/env node\n", { mode: 0o755 });
    // A missing PATH must never be read as the cwd, or a project-local hacpd could be run by accident.
    expect(findExecutable("hacpd", {}, dir)).toBeNull();
    expect(resolveServerLaunch({ serverEntry: null }, {}, dir)).toEqual({ kind: "module", specifier: DEFAULT_SERVER_MODULE });
    // An explicit empty PATH keeps the POSIX "empty component = cwd" meaning.
    expect(findExecutable("hacpd", { PATH: "" }, dir)).toBe(realpathSync(join(dir, "hacpd")));
    expect(resolveServerLaunch({ serverEntry: null }, { PATH: "" }, dir)).toEqual({ kind: "command", command: realpathSync(join(dir, "hacpd")) });
  });
});
