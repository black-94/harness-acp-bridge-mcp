import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS, DEFAULT_STARTUP_TIMEOUT_MS, isLoopback, normalizeBaseUrl, readSettings, serverEntrySpecifier } from "../src/config.ts";

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
});
