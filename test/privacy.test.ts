/**
 * Privacy tests for the MCP client's persisted copies.
 *
 * Part A exercises the streamed redactor directly (arbitrary chunk splits, split Unicode, PEM,
 * provider/env literals, and a bounded over-long unterminated value).
 * Part B drives the **real** `ServerLifecycle.ensure()` with a real fake HTTP server module. The
 * server's stdout/stderr fds are pipes owned by the detached supervisor, so `console`,
 * `stream.write`, `fs.writeSync(1/2)`, and `fs.writevSync` are all trapped. The assertions read
 * the *raw on-disk log file* (never `redact()` output) and require no sentinel to survive while
 * ordinary text, timestamps, and multibyte characters are preserved. It also proves pid
 * ownership (ping pid === recorded server pid, supervisor pid recorded), a true client-exit
 * reuse, and orphan-free cleanup on failure.
 *
 * Fixtures only; no real secret values, no paid model, no Docker, no SSH.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerLifecycle } from "../src/lifecycle.ts";
import type { McpSettings } from "../src/config.ts";
import { isSensitiveKeyName, redactText, redactValue, StreamRedactor } from "../src/redact.ts";

const here = dirname(fileURLToPath(import.meta.url));
const bootstrap = resolve(here, "../dist/bootstrap.js");
const lifecycleModule = pathToFileURL(resolve(here, "../dist/lifecycle.js")).href;
const noisyFixture = resolve(here, "fixtures/noisy-http-server.mjs");
const failingFixture = resolve(here, "fixtures/failing-server.mjs");
const starterHelper = resolve(here, "fixtures/starter-client.mjs");

const FAKE_ENV_SECRET = "fakeEnvLiteralValue9876543210";
const CRED_SENTINEL = "CREDSENTINEL0123456789abcdef";
const PEM_BODY = "MIIfakebodyline-one";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "mcp-privacy-"));
  dirs.push(dir);
  return dir;
}

/** Feed `input` to a fresh stream redactor one byte at a time; return everything emitted. */
function streamByteByByte(input: string, secrets: readonly string[] = []): string {
  const redactor = new StreamRedactor(secrets, "utf8");
  const bytes = Buffer.from(input, "utf8");
  const parts: Buffer[] = [];
  for (let index = 0; index < bytes.length; index++) {
    const out = redactor.push(bytes.subarray(index, index + 1));
    if (out.length) parts.push(out);
  }
  const tail = redactor.flush();
  if (tail.length) parts.push(tail);
  return Buffer.concat(parts).toString("utf8");
}

describe("redaction rules", () => {
  it("masks sensitive keys but preserves counters and public keys", () => {
    expect(isSensitiveKeyName("accessToken")).toBe(true);
    expect(isSensitiveKeyName("AWS_SECRET_ACCESS_KEY")).toBe(true);
    expect(isSensitiveKeyName("max_tokens")).toBe(false);
    expect(isSensitiveKeyName("token_count")).toBe(false);
    expect(isSensitiveKeyName("public_key")).toBe(false);
    expect(isSensitiveKeyName("email")).toBe(false);
  });

  it("masks nested sensitive fields and body credentials, preserving ordinary text", () => {
    const nested = redactValue({ message_id: "m1", error: { code: "x", password: "hunter2", note: "中文😀 stays" }, token: "abcdef1234567890" });
    expect(nested).toEqual({ message_id: "m1", error: { code: "x", password: "[REDACTED]", note: "中文😀 stays" }, token: "[REDACTED]" });
    expect(redactText("curl -H 'Authorization: Bearer ghp_abcdefghijklmnopqrstuvwx' https://x")).toContain("[REDACTED]");
    expect(redactText("plain text 中文😀 with no secret")).toBe("plain text 中文😀 with no secret");
  });
});

describe("stream redactor across arbitrary boundaries", () => {
  it("round-trips ordinary multibyte text byte-split (no truncation)", () => {
    const text = "ordinary 中文😀 line\n";
    expect(streamByteByByte(text)).toBe(text);
  });

  it("masks an env literal split at any byte while preserving surrounding text", () => {
    const input = `before 中文😀 token=${FAKE_ENV_SECRET} tail 😀\n`;
    const out = streamByteByByte(input, [FAKE_ENV_SECRET]);
    expect(out).not.toContain(FAKE_ENV_SECRET);
    expect(out).toContain("[REDACTED]");
    expect(out).toContain("before 中文😀");
    expect(out).toContain("tail 😀");
  });

  it("masks a provider token split mid-token", () => {
    const out = streamByteByByte(`header Authorization: Bearer sk-ant-${CRED_SENTINEL} end\n`);
    expect(out).not.toContain(CRED_SENTINEL);
    expect(out).toContain("header Authorization: [REDACTED]");
  });

  it("collapses a PEM private key split across chunks and keeps the surrounding lines", () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----\n${PEM_BODY}\n${"A".repeat(64)}\n-----END RSA PRIVATE KEY-----`;
    const out = streamByteByByte(`line-before 中文\n${pem}\nline-after 😀\n`);
    expect(out).not.toContain(PEM_BODY);
    expect(out).not.toContain("PRIVATE KEY");
    expect(out).toContain("line-before 中文");
    expect(out).toContain("line-after 😀");
    expect(out).toContain("[REDACTED]");
  });

  it("bounds memory and never emits an 8 MiB unterminated sensitive value", () => {
    const redactor = new StreamRedactor([], "utf8");
    const secretValue = "S".repeat(8 * 1024 * 1024);
    let emitted = 0;
    const chunkOf = (text: string): void => { const out = redactor.push(Buffer.from(text, "utf8")); emitted += out.length; };
    chunkOf("password=");
    for (let offset = 0; offset < secretValue.length; offset += 64 * 1024) {
      chunkOf(secretValue.slice(offset, offset + 64 * 1024));
    }
    chunkOf("\nnext ordinary line 中文😀\n");
    const tail = redactor.flush();
    emitted += tail.length;
    expect(emitted).toBeLessThan(4096);
  });
});

// ---------------------------------------------------------------------------
// Real lifecycle-driven fd boundary: read the persisted log, not redact()
// ---------------------------------------------------------------------------

function settings(baseUrl: string, overrides: Partial<McpSettings> = {}): McpSettings {
  return { baseUrl, timeoutMs: 15000, autoStart: true, serverEntry: null, configPath: null, startupTimeoutMs: 8000, ...overrides };
}

function registry(dir: string): Record<string, { pid: number | null; logger_pid: number | null; log: string; started_at: string }> {
  try { return JSON.parse(readFileSync(join(dir, "servers.json"), "utf8")); } catch { return {}; }
}

function key(baseUrl: string): string { return baseUrl.replace(/[^A-Za-z0-9]+/g, "_"); }

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function waitDead(pid: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (!alive(pid)) return true; await new Promise(resolve => setTimeout(resolve, 25)); }
  return !alive(pid);
}

async function nextFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

async function pingPid(baseUrl: string): Promise<number> {
  const response = await fetch(`${baseUrl}/api/ping`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const body = await response.json() as { data: { pid: number } };
  return body.data.pid;
}

async function ensureDead(...pids: Array<number | null | undefined>): Promise<void> {
  for (const pid of pids) if (typeof pid === "number") await waitDead(pid);
}

describe.runIf(existsSync(bootstrap))("MCP lifecycle fd-level log boundary", () => {
  it("masks every write path in the raw log and proves pid ownership", async () => {
    const dir = tempDir();
    const clientDir = join(dir, "client");
    const port = await nextFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const config = join(dir, "config.json");
    writeFileSync(config, JSON.stringify({ port }));
    vi.stubEnv("FAKE_API_KEY", FAKE_ENV_SECRET);
    const env = { ...process.env, HARNESS_ACP_BRIDGE_CLIENT_DIR: clientDir };
    const lifecycle = new ServerLifecycle(settings(baseUrl, { configPath: config, serverEntry: pathToFileURL(noisyFixture).href }), env);

    const result = await lifecycle.ensure();
    expect(result).toMatchObject({ owned: true, baseUrl });
    expect(result.pid).toBeGreaterThan(0);
    expect(result.loggerPid).toBeGreaterThan(0);

    // Directory + file modes.
    expect(statSync(clientDir).mode & 0o777).toBe(0o700);
    const entry = registry(clientDir)[baseUrl]!;
    expect(statSync(entry.log).mode & 0o777).toBe(0o600);

    // Proof of ownership: ping pid === recorded server pid, and the supervisor pid is recorded.
    expect(await pingPid(baseUrl)).toBe(result.pid);
    expect(entry.pid).toBe(result.pid);
    expect(entry.logger_pid).toBe(result.loggerPid);

    // Terminate the server; the supervisor flushes the held (redacted) tails at EOF before exit.
    try { process.kill(result.pid!, "SIGTERM"); } catch { /* gone */ }
    await ensureDead(result.pid, result.loggerPid);

    const raw = readFileSync(entry.log, "utf8");
    // No sentinel from any path (stream, console, fd write, fd writev, PEM, provider).
    expect(raw).not.toContain(FAKE_ENV_SECRET);
    expect(raw).not.toContain(CRED_SENTINEL);
    expect(raw).not.toContain(PEM_BODY);
    expect(raw).not.toContain("PRIVATE KEY");
    expect(raw).not.toContain("MIIfakebodyline-two");
    // Ordinary diagnostics and unknown text survive verbatim (the log is not blanked).
    expect(raw).toContain("stdout ordinary 中文😀 ok");
    expect(raw).toContain("console line");
    expect(raw).toContain("[REDACTED]");
  });

  it("keeps masking after the starter client has fully exited, and a second client reuses the server", async () => {
    const dir = tempDir();
    const clientDir = join(dir, "client");
    const port = await nextFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const config = join(dir, "config.json");
    writeFileSync(config, JSON.stringify({ port }));
    const starterSettings = settings(baseUrl, { configPath: config, serverEntry: pathToFileURL(noisyFixture).href });

    // A real, separate client process starts the server and then exits completely.
    const helper = spawn(process.execPath, [starterHelper], {
      env: { ...process.env, FAKE_API_KEY: FAKE_ENV_SECRET, HARNESS_ACP_BRIDGE_CLIENT_DIR: clientDir, HARNESS_STARTER_LIFECYCLE: lifecycleModule, HARNESS_STARTER_SETTINGS: JSON.stringify(starterSettings) },
      stdio: ["ignore", "pipe", "inherit"],
    });
    const stdout: Buffer[] = [];
    helper.stdout!.on("data", chunk => stdout.push(chunk as Buffer));
    const code = await new Promise<number | null>(resolve => helper.on("exit", resolve));
    expect(code).toBe(0);
    const started = JSON.parse(Buffer.concat(stdout).toString("utf8")) as { owned: boolean; pid: number; loggerPid: number };
    expect(started.owned).toBe(true);

    // The starter is gone; the server and its supervisor survive.
    expect(await pingPid(baseUrl)).toBe(started.pid);
    const entry = registry(clientDir)[baseUrl]!;
    const rawAfterStarter = join(clientDir, `server-${key(baseUrl)}.log`);
    expect(entry.log).toBe(rawAfterStarter);
    const before = readFileSync(entry.log, "utf8").length;

    // A second client reuses the already-running server (owned: false), does not start another.
    const reuse = new ServerLifecycle(settings(baseUrl, { configPath: config, serverEntry: pathToFileURL(noisyFixture).href }), { ...process.env, FAKE_API_KEY: FAKE_ENV_SECRET, HARNESS_ACP_BRIDGE_CLIENT_DIR: clientDir });
    expect(await reuse.ensure()).toMatchObject({ owned: false, pid: null });
    // Only one instance remains recorded for this address.
    expect(Object.keys(registry(clientDir))).toEqual([baseUrl]);

    await new Promise(resolve => setTimeout(resolve, 300));
    // Terminate the reused server; the supervisor flushes everything it masked after the starter left.
    try { process.kill(started.pid, "SIGTERM"); } catch { /* gone */ }
    await ensureDead(started.pid, started.loggerPid);

    const after = readFileSync(entry.log, "utf8");
    expect(after.length).toBeGreaterThan(before); // the still-running server kept logging
    expect(after).not.toContain(FAKE_ENV_SECRET);
    expect(after).not.toContain(CRED_SENTINEL);
    expect(after).not.toContain(PEM_BODY);
    expect(after).toContain("[REDACTED]");
    expect(after).toContain("stdout ordinary 中文😀 ok");
  });

  it("fails with a sanitized import diagnostic and leaves no orphan when the server module throws", async () => {
    const dir = tempDir();
    const clientDir = join(dir, "client");
    const port = await nextFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const config = join(dir, "config.json");
    writeFileSync(config, JSON.stringify({ port }));
    vi.stubEnv("FAKE_API_KEY", FAKE_ENV_SECRET);
    const env = { ...process.env, HARNESS_ACP_BRIDGE_CLIENT_DIR: clientDir };
    const lifecycle = new ServerLifecycle(settings(baseUrl, { configPath: config, serverEntry: pathToFileURL(failingFixture).href, startupTimeoutMs: 6000 }), env);

    await expect(lifecycle.ensure()).rejects.toMatchObject({ code: "startup_failed" });
    // Registry is empty and nothing lingers.
    expect(registry(clientDir)).toEqual({});
    const proofPath = join(clientDir, `launch-${key(baseUrl)}.json`);
    const proof = JSON.parse(readFileSync(proofPath, "utf8")) as { launcher_pid: number; server_pid: number | null };
    await ensureDead(proof.launcher_pid, proof.server_pid);
    // The failure diagnostic is present in the log and sanitized.
    const logPath = join(clientDir, `server-${key(baseUrl)}.log`);
    if (existsSync(logPath)) {
      const raw = readFileSync(logPath, "utf8");
      expect(raw).not.toContain(FAKE_ENV_SECRET);
      expect(raw).not.toContain("MIIfakebodyline-one");
    }
  });

  it("reclaims a server that never answers the configured address, without orphans", async () => {
    const dir = tempDir();
    const clientDir = join(dir, "client");
    const baseUrlPort = await nextFreePort();
    const listenPort = await nextFreePort();
    const baseUrl = `http://127.0.0.1:${baseUrlPort}`;
    const config = join(dir, "config.json");
    writeFileSync(config, JSON.stringify({ port: listenPort })); // listens elsewhere -> never satisfies ping
    vi.stubEnv("FAKE_API_KEY", FAKE_ENV_SECRET);
    const env = { ...process.env, HARNESS_ACP_BRIDGE_CLIENT_DIR: clientDir };
    const lifecycle = new ServerLifecycle(settings(baseUrl, { configPath: config, serverEntry: pathToFileURL(noisyFixture).href, startupTimeoutMs: 2500 }), env);

    await expect(lifecycle.ensure()).rejects.toMatchObject({ code: "startup_failed" });
    expect(registry(clientDir)).toEqual({});
    const proofPath = join(clientDir, `launch-${key(baseUrl)}.json`);
    const proof = JSON.parse(readFileSync(proofPath, "utf8")) as { launcher_pid: number; server_pid: number | null };
    await ensureDead(proof.launcher_pid, proof.server_pid);
  });
});
