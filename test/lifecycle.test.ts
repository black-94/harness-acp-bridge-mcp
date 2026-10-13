import { createServer, type Server } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerLifecycle, redact } from "../src/lifecycle.ts";
import type { McpSettings } from "../src/config.ts";
import { bridgeConfig, freePort, killRegistryServers, newContractServerCli, newContractServerEntry, registry, serverAvailable } from "./support.ts";

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

  it("refuses a still-running protocol-3 daemon without restarting or killing it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-life-"));
    const port = await freePort();
    // The previous public contract: an occupied listener on protocol 3 must be refused, never taken
    // over, restarted, or killed by the client.
    const listener = await stubListener(port, 3);
    cleanups.push(() => new Promise<void>(resolve => listener.close(() => resolve())));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const clientDir = join(dir, "client");
    const lifecycle = new ServerLifecycle(settings(`http://127.0.0.1:${port}`, clientDir), { ...process.env, HARNESS_ACP_BRIDGE_CLIENT_DIR: clientDir });
    expect(await lifecycle.probe()).toBe("incompatible");
    await expect(lifecycle.ensure()).rejects.toMatchObject({ code: "incompatible_server" });
    expect(registry(clientDir)).toEqual({});
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

  it("does not run an inherited SERVER_COMMAND when an explicit module entry is selected", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-life-"));
    const port = await freePort();
    const config = join(dir, "config.yaml");
    writeFileSync(config, bridgeConfig(port, join(dir, "sessions")));
    const clientDir = join(dir, "client");
    const marker = join(dir, "hijack.marker");
    const evil = join(dir, "evil-command.cjs");
    writeFileSync(evil, `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`);
    chmodSync(evil, 0o755);
    cleanups.push(() => { killRegistryServers(clientDir); rmSync(dir, { recursive: true, force: true }); });
    const baseUrl = `http://127.0.0.1:${port}`;
    const env = { ...process.env, HARNESS_ACP_BRIDGE_CLIENT_DIR: clientDir, HARNESS_ACP_BRIDGE_SERVER_COMMAND: evil };

    // `settings()` defaults to an explicit module entry, so the injected command must be cleared.
    const result = await new ServerLifecycle(settings(baseUrl, clientDir, { configPath: config }), env).ensure();
    expect(result).toMatchObject({ owned: true });
    expect(existsSync(marker)).toBe(false);
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

});

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function waitDead(pid: number, timeoutMs = 6000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (!alive(pid)) return true; await new Promise(resolve => setTimeout(resolve, 25)); }
  return !alive(pid);
}

describe.runIf(serverAvailable() && newContractServerCli() !== null)("managed local server via a PATH hacpd CLI", () => {
  function cliSettings(baseUrl: string, clientDir: string, overrides: Partial<McpSettings> = {}): McpSettings {
    return { baseUrl, timeoutMs: 15000, autoStart: true, serverEntry: null, configPath: null, startupTimeoutMs: 8000, ...overrides };
  }
  function fakeBin(dir: string, source: string): { bin: string; env: NodeJS.ProcessEnv } {
    const target = newContractServerCli()!;
    const bin = join(dir, "bin");
    mkdirSync(bin);
    if (source === "symlink") {
      // Emulate an npm global bin: an *executable* Node script (the repo's dist/main.js is not
      // chmod +x) reached through a symlink, whose realpath is followed and whose shebang lets the
      // supervisor run it under `node --import <watchdog>`. The shim runs the real CLI in-process.
      const shim = join(dir, "hacpd-shim.mjs");
      writeFileSync(shim, `#!/usr/bin/env node\nimport(${JSON.stringify(pathToFileURL(target).href)});\n`, { mode: 0o755 });
      symlinkSync(shim, join(bin, "hacpd"));
    } else {
      writeFileSync(join(bin, "hacpd"), source, { mode: 0o755 });
    }
    return { bin, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` } };
  }
  function configFor(dir: string, port: number): string {
    const config = join(dir, "config.yaml");
    writeFileSync(config, bridgeConfig(port, join(dir, "sessions")));
    return config;
  }
  function serverRecord(clientDir: string, baseUrl: string): { pid: number; logger_pid: number } {
    return registry(clientDir)[baseUrl] as unknown as { pid: number; logger_pid: number };
  }

  it("starts the real hacpd CLI, proves exact pid ownership, and reuses it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-cli-"));
    const clientDir = join(dir, "client");
    const { env } = fakeBin(dir, "symlink");
    const port = await freePort();
    const config = configFor(dir, port);
    const baseUrl = `http://127.0.0.1:${port}`;
    cleanups.push(() => { killRegistryServers(clientDir); rmSync(dir, { recursive: true, force: true }); });
    const withDir = { ...env, HARNESS_ACP_BRIDGE_CLIENT_DIR: clientDir };

    const started = await new ServerLifecycle(cliSettings(baseUrl, clientDir, { configPath: config }), withDir).ensure();
    expect(started).toMatchObject({ owned: true, baseUrl });
    expect(started.pid).toBeGreaterThan(0);
    // The answered ping pid is exactly the recorded server pid (the CLI process, not the supervisor).
    expect(registry(clientDir)[baseUrl].pid).toBe(started.pid);
    expect(registry(clientDir)[baseUrl].logger_pid).not.toBe(started.pid);
    expect(await new ServerLifecycle(cliSettings(baseUrl, clientDir, { configPath: config }), withDir).ensure()).toMatchObject({ owned: false });
    expect(await new ServerLifecycle(cliSettings(baseUrl, clientDir, { configPath: config }), withDir).probe()).toBe("ok");
  });

  it("converges concurrent command-mode starts on one instance (peer race)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-cli-"));
    const clientDir = join(dir, "client");
    const { env } = fakeBin(dir, "symlink");
    const port = await freePort();
    const config = configFor(dir, port);
    const baseUrl = `http://127.0.0.1:${port}`;
    cleanups.push(() => { killRegistryServers(clientDir); rmSync(dir, { recursive: true, force: true }); });
    const withDir = { ...env, HARNESS_ACP_BRIDGE_CLIENT_DIR: clientDir };

    const results = await Promise.all([
      new ServerLifecycle(cliSettings(baseUrl, clientDir, { configPath: config }), withDir).ensure(),
      new ServerLifecycle(cliSettings(baseUrl, clientDir, { configPath: config }), withDir).ensure(),
    ]);
    expect(results.filter(result => result.owned)).toHaveLength(1);
    expect(results.every(result => result.baseUrl === baseUrl)).toBe(true);
    expect(Object.keys(registry(clientDir))).toEqual([baseUrl]);
  });

  it("does not orphan the CLI when the supervisor is SIGKILLed (stdin-EOF watchdog)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-cli-"));
    const clientDir = join(dir, "client");
    const { env } = fakeBin(dir, "symlink");
    const port = await freePort();
    const config = configFor(dir, port);
    const baseUrl = `http://127.0.0.1:${port}`;
    cleanups.push(() => { killRegistryServers(clientDir); rmSync(dir, { recursive: true, force: true }); });
    const withDir = { ...env, HARNESS_ACP_BRIDGE_CLIENT_DIR: clientDir };

    const started = await new ServerLifecycle(cliSettings(baseUrl, clientDir, { configPath: config }), withDir).ensure();
    const record = registry(clientDir)[baseUrl];
    expect(record.pid).toBe(started.pid);
    expect(record.logger_pid).toBeGreaterThan(0);
    expect(alive(record.pid!)).toBe(true);

    process.kill(record.logger_pid!, "SIGKILL");
    expect(await waitDead(record.pid!)).toBe(true);
  });

  it("refuses a non-Node hacpd wrapper and never runs it unobserved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-cli-"));
    const clientDir = join(dir, "client");
    const { env } = fakeBin(dir, "#!/bin/sh\nexit 0\n");
    const port = await freePort();
    const config = configFor(dir, port);
    const baseUrl = `http://127.0.0.1:${port}`;
    cleanups.push(() => { killRegistryServers(clientDir); rmSync(dir, { recursive: true, force: true }); });
    const withDir = { ...env, HARNESS_ACP_BRIDGE_CLIENT_DIR: clientDir };

    let error: unknown;
    try { await new ServerLifecycle(cliSettings(baseUrl, clientDir, { configPath: config }), withDir).ensure(); }
    catch (cause) { error = cause; }
    expect((error as { code?: string }).code).toBe("startup_failed");
    expect(String(error)).toMatch(/Node script|supported server command/);
    expect(registry(clientDir)).toEqual({});
  });

  it("hard-fails (no fallback) when a Node hacpd is found but never serves", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-cli-"));
    const clientDir = join(dir, "client");
    const { env } = fakeBin(dir, "#!/usr/bin/env node\nprocess.exit(1)\n");
    const port = await freePort();
    const config = configFor(dir, port);
    const baseUrl = `http://127.0.0.1:${port}`;
    cleanups.push(() => { killRegistryServers(clientDir); rmSync(dir, { recursive: true, force: true }); });
    const withDir = { ...env, HARNESS_ACP_BRIDGE_CLIENT_DIR: clientDir };

    // A silent fallback to the installed (protocol-2) module would surface incompatible_server
    // instead; startup_failed proves the explicitly-found command was used and its failure is final.
    let error: unknown;
    try { await new ServerLifecycle(cliSettings(baseUrl, clientDir, { configPath: config, startupTimeoutMs: 3000 }), withDir).ensure(); }
    catch (cause) { error = cause; }
    expect((error as { code?: string }).code).toBe("startup_failed");
    expect(registry(clientDir)).toEqual({});
  });

  it("stops the CLI server and its supervisor when the server is SIGTERMed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-cli-"));
    const clientDir = join(dir, "client");
    const { env } = fakeBin(dir, "symlink");
    const port = await freePort();
    const config = configFor(dir, port);
    const baseUrl = `http://127.0.0.1:${port}`;
    cleanups.push(() => { killRegistryServers(clientDir); rmSync(dir, { recursive: true, force: true }); });
    const withDir = { ...env, HARNESS_ACP_BRIDGE_CLIENT_DIR: clientDir };

    await new ServerLifecycle(cliSettings(baseUrl, clientDir, { configPath: config }), withDir).ensure();
    const record = serverRecord(clientDir, baseUrl);
    process.kill(record.pid, "SIGTERM");
    expect(await waitDead(record.pid)).toBe(true);
    expect(await waitDead(record.logger_pid)).toBe(true);
  });

  it("stops the CLI server too when the supervisor is SIGTERMed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-cli-"));
    const clientDir = join(dir, "client");
    const { env } = fakeBin(dir, "symlink");
    const port = await freePort();
    const config = configFor(dir, port);
    const baseUrl = `http://127.0.0.1:${port}`;
    cleanups.push(() => { killRegistryServers(clientDir); rmSync(dir, { recursive: true, force: true }); });
    const withDir = { ...env, HARNESS_ACP_BRIDGE_CLIENT_DIR: clientDir };

    await new ServerLifecycle(cliSettings(baseUrl, clientDir, { configPath: config }), withDir).ensure();
    const record = serverRecord(clientDir, baseUrl);
    process.kill(record.logger_pid, "SIGTERM");
    expect(await waitDead(record.logger_pid)).toBe(true);
    expect(await waitDead(record.pid)).toBe(true);
  });

  it("does not import an inherited SERVER_MODULE when hacpd is selected", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-cli-"));
    const clientDir = join(dir, "client");
    const { env } = fakeBin(dir, "symlink");
    const port = await freePort();
    const config = configFor(dir, port);
    const baseUrl = `http://127.0.0.1:${port}`;
    const marker = join(dir, "hijack.marker");
    const evilModule = join(dir, "evil-module.mjs");
    writeFileSync(evilModule, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\n`);
    cleanups.push(() => { killRegistryServers(clientDir); rmSync(dir, { recursive: true, force: true }); });
    // Command mode is selected (PATH hacpd); the injected module entry must be cleared, not imported.
    const withDir = { ...env, HARNESS_ACP_BRIDGE_CLIENT_DIR: clientDir, HARNESS_ACP_BRIDGE_SERVER_MODULE: evilModule };

    const started = await new ServerLifecycle(cliSettings(baseUrl, clientDir, { configPath: config }), withDir).ensure();
    expect(started).toMatchObject({ owned: true });
    expect(existsSync(marker)).toBe(false);
  });
});
