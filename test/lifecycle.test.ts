import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerLifecycle, redact } from "../src/lifecycle.ts";
import type { McpSettings } from "../src/config.ts";
import { ServerLifecycle as PiServerLifecycle } from "../../pi-extension/src/lifecycle.ts";
import { bridgeConfig, freePort, killRegistryServers, newContractServerEntry, registry, serverAvailable } from "./support.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

function settings(baseUrl: string, clientDir: string, overrides: Partial<McpSettings> = {}): McpSettings {
  return { baseUrl, timeoutMs: 15000, autoStart: true, serverEntry: newContractServerEntry(), configPath: null, startupTimeoutMs: 15000, ...overrides };
}

async function stubListener(port: number, protocolVersion: unknown): Promise<Server> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, data: { status: "ok", protocol_version: protocolVersion } }));
  });
  await new Promise<void>(resolve => server.listen(port, "127.0.0.1", () => resolve()));
  return server;
}

describe("diagnostics redaction", () => {
  it("masks credentials and control sequences from server logs", () => {
    const output = redact("connect token=SECRETVALUE\x1b[31m and api key abcdef123456", { API_KEY: "abcdef123456" });
    expect(output).not.toContain("SECRETVALUE");
    expect(output).not.toContain("abcdef123456");
    expect(output).not.toContain("\x1b");
  });
});

describe("protocol compatibility (no server spawn)", () => {
  it("treats a reachable but incompatible listener as present and starts nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-life-"));
    const port = await freePort();
    const listener = await stubListener(port, 1);
    cleanups.push(() => new Promise<void>(resolve => listener.close(() => resolve())));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const clientDir = join(dir, "client");
    const lifecycle = new ServerLifecycle(settings(`http://127.0.0.1:${port}`, clientDir), { ...process.env, HARNESS_ACP_BRIDGE_CLIENT_DIR: clientDir });
    expect(await lifecycle.probe()).toBe("incompatible");
    await expect(lifecycle.ensure()).rejects.toMatchObject({ code: "incompatible_server" });
    expect(registry(clientDir)).toEqual({});
  });

  it("rejects an older-protocol daemon without restarting or killing it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-life-"));
    const port = await freePort();
    const listener = await stubListener(port, 2);
    cleanups.push(() => new Promise<void>(resolve => listener.close(() => resolve())));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const clientDir = join(dir, "client");
    const lifecycle = new ServerLifecycle(settings(`http://127.0.0.1:${port}`, clientDir), { ...process.env, HARNESS_ACP_BRIDGE_CLIENT_DIR: clientDir });
    expect(await lifecycle.probe()).toBe("incompatible");
    await expect(lifecycle.ensure()).rejects.toMatchObject({ code: "incompatible_server" });
    expect(registry(clientDir)).toEqual({});
    // The old daemon is still serving; it was neither replaced nor killed.
    const response = await fetch(`http://127.0.0.1:${port}/api/ping`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect((await response.json() as { ok: boolean }).ok).toBe(true);
  });
});

describe.runIf(serverAvailable())("managed local server lifecycle", () => {
  it("starts a loopback server on demand, reuses it, and records one instance", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-life-"));
    const port = await freePort();
    const config = join(dir, "config.yaml");
    writeFileSync(config, bridgeConfig(port, join(dir, "sessions")));
    const baseUrl = `http://127.0.0.1:${port}`;
    const clientDir = join(dir, "client");
    cleanups.push(() => { killRegistryServers(clientDir); rmSync(dir, { recursive: true, force: true }); });

    const first = new ServerLifecycle(settings(baseUrl, clientDir, { configPath: config }), { ...process.env, HARNESS_ACP_BRIDGE_CLIENT_DIR: clientDir });
    expect(await first.probe()).toBe("down");
    const started = await first.ensure();
    expect(started).toMatchObject({ owned: true, baseUrl });
    expect(started.pid).toBeGreaterThan(0);
    expect(await first.probe()).toBe("ok");

    const second = new ServerLifecycle(settings(baseUrl, clientDir, { configPath: config }), { ...process.env, HARNESS_ACP_BRIDGE_CLIENT_DIR: clientDir });
    expect(await second.ensure()).toMatchObject({ owned: false });
    expect(Object.keys(registry(clientDir))).toEqual([baseUrl]);
  });

  it("refuses to start when autostart is disabled or the address is not loopback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-life-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const clientDir = join(dir, "client");
    const port = await freePort();
    const offline = new ServerLifecycle(settings(`http://127.0.0.1:${port}`, clientDir, { autoStart: false }), { ...process.env, HARNESS_ACP_BRIDGE_CLIENT_DIR: clientDir });
    await expect(offline.ensure()).rejects.toMatchObject({ code: "server_unreachable" });

    const remote = new ServerLifecycle(settings("http://harness-acp-bridge.invalid:8787", clientDir), { ...process.env, HARNESS_ACP_BRIDGE_CLIENT_DIR: clientDir });
    await expect(remote.ensure()).rejects.toThrow(/refusing to start a local server/);
    expect(registry(clientDir)).toEqual({});
  });

  it("converges two concurrent starts on a single instance", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-life-"));
    const port = await freePort();
    const config = join(dir, "config.yaml");
    writeFileSync(config, bridgeConfig(port, join(dir, "sessions")));
    const baseUrl = `http://127.0.0.1:${port}`;
    const clientDir = join(dir, "client");
    cleanups.push(() => { killRegistryServers(clientDir); rmSync(dir, { recursive: true, force: true }); });
    const env = { ...process.env, HARNESS_ACP_BRIDGE_CLIENT_DIR: clientDir };
    const results = await Promise.all([
      new ServerLifecycle(settings(baseUrl, clientDir, { configPath: config }), env).ensure(),
      new ServerLifecycle(settings(baseUrl, clientDir, { configPath: config }), env).ensure(),
    ]);
    expect(results.some(result => result.owned)).toBe(true);
    expect((results[0] as { baseUrl: string }).baseUrl).toBe(baseUrl);
    expect(Object.keys(registry(clientDir))).toEqual([baseUrl]);
  });

  it("starts a server from a file: URL entry without double-converting it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-life-"));
    const port = await freePort();
    const config = join(dir, "config.yaml");
    writeFileSync(config, bridgeConfig(port, join(dir, "sessions")));
    const clientDir = join(dir, "client");
    cleanups.push(() => { killRegistryServers(clientDir); rmSync(dir, { recursive: true, force: true }); });
    const entry = pathToFileURL(newContractServerEntry()!).href;
    const baseUrl = `http://127.0.0.1:${port}`;
    const env = { ...process.env, HARNESS_ACP_BRIDGE_CLIENT_DIR: clientDir };
    const result = await new ServerLifecycle(settings(baseUrl, clientDir, { configPath: config, serverEntry: entry }), env).ensure();
    expect(result).toMatchObject({ owned: true });
    expect(await new ServerLifecycle(settings(baseUrl, clientDir, { configPath: config }), env).probe()).toBe("ok");
  });

  it("rejects a foreign listener that appears while the start lock is held", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-life-"));
    const clientDir = join(dir, "client");
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const lifecycle = new ServerLifecycle(settings("http://127.0.0.1:1", clientDir), { ...process.env, HARNESS_ACP_BRIDGE_CLIENT_DIR: clientDir });
    vi.spyOn(lifecycle, "probe").mockResolvedValueOnce("down").mockResolvedValueOnce("incompatible");
    await expect(lifecycle.ensure()).rejects.toMatchObject({ code: "incompatible_server" });
    expect(registry(clientDir)).toEqual({});
  });

  it("fails clearly when the started server listens on a different port", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-life-"));
    const baseUrlPort = await freePort();
    const configPort = await freePort();
    const config = join(dir, "config.yaml");
    writeFileSync(config, bridgeConfig(configPort, join(dir, "sessions"))); // server listens on configPort
    const clientDir = join(dir, "client");
    cleanups.push(() => { killRegistryServers(clientDir); rmSync(dir, { recursive: true, force: true }); });
    const env = { ...process.env, HARNESS_ACP_BRIDGE_CLIENT_DIR: clientDir };
    // baseUrl points at a different port, so the child never satisfies our ping.
    const lifecycle = new ServerLifecycle(settings(`http://127.0.0.1:${baseUrlPort}`, clientDir, { configPath: config, startupTimeoutMs: 2500 }), env);
    await expect(lifecycle.ensure()).rejects.toMatchObject({ code: "startup_failed" });
    expect(registry(clientDir)).toEqual({});
  });

  it("has a Pi client and an MCP client share a single started instance", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-life-"));
    const port = await freePort();
    const config = join(dir, "config.yaml");
    writeFileSync(config, bridgeConfig(port, join(dir, "sessions")));
    const baseUrl = `http://127.0.0.1:${port}`;
    const clientDir = join(dir, "client");
    cleanups.push(() => { killRegistryServers(clientDir); rmSync(dir, { recursive: true, force: true }); });
    const env = { ...process.env, HARNESS_ACP_BRIDGE_CLIENT_DIR: clientDir };
    const piSettings = { baseUrl, requestTimeoutMs: 15000, interactionTimeoutMs: 5000, pollIntervalMs: 200, autoStart: true, serverEntry: newContractServerEntry(), configPath: config, startupTimeoutMs: 15000 };
    const results = await Promise.all([
      new ServerLifecycle(settings(baseUrl, clientDir, { configPath: config }), env).ensure(),
      new PiServerLifecycle(piSettings, env).ensure(),
    ]);
    expect(results.filter(result => result.owned)).toHaveLength(1);
    expect(results.every(result => result.baseUrl === baseUrl)).toBe(true);
    expect(Object.keys(registry(clientDir))).toEqual([baseUrl]);
  });
});
