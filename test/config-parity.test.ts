/**
 * Cross-client settings parity (driven from the MCP package).
 *
 * Drives the *real* `readSettings` (MCP proxy, local) and the *real* `loadSettings` (Pi extension,
 * sibling repo) over one matrix and asserts they agree: either both reject a source, or both
 * resolve the same final value for every shared key. This is the guard against the two clients
 * drifting apart on input/precedence semantics (env > merged JSON > default, with only the final
 * value validated).
 *
 * The clients are independent git repositories, so the sibling is loaded **dynamically** and only
 * when present: a standalone `mcp/` checkout skips just this parity group instead of failing test
 * collection. Set `ACP_BRIDGE_PARITY_SIBLING` to the sibling `config.ts` path to point elsewhere.
 *
 * The two clients use different JSON key names for the per-request timeout (`timeoutMs` vs
 * `requestTimeoutMs`) and different default timeout values, so the two files are generated from a
 * shared MCP-keyed spec and the timeout is compared only when a case sets it explicitly.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readSettings } from "../src/config.ts";

interface SharedResult { baseUrl: string; startupTimeoutMs: number; autoStart: boolean; serverEntry: string | null; configPath: string | null }
interface PiLike extends SharedResult { requestTimeoutMs: number }

const here = dirname(fileURLToPath(import.meta.url));
const siblingPath = process.env.ACP_BRIDGE_PARITY_SIBLING ?? resolve(here, "../../pi-extension/src/config.ts");
let piLoadSettings: ((cwd: string, env: NodeJS.ProcessEnv) => PiLike) | null = null;
if (existsSync(siblingPath)) {
  try {
    const sibling = await import(pathToFileURL(siblingPath).href) as { loadSettings?: (cwd: string, env: NodeJS.ProcessEnv) => PiLike };
    if (typeof sibling.loadSettings === "function") piLoadSettings = sibling.loadSettings;
  } catch { piLoadSettings = null; }
}

const dirs: string[] = [];
function temp(prefix = "cfg-parity-"): string { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir; }
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

/** MCP-keyed fields; the Pi file is the same with `timeoutMs` renamed to `requestTimeoutMs`. */
function piFileText(fields: Record<string, unknown>): string {
  const renamed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) renamed[key === "timeoutMs" ? "requestTimeoutMs" : key] = value;
  return JSON.stringify(renamed);
}

interface Case {
  name: string;
  /** MCP-keyed fields written to both settings files. */
  fields?: Record<string, unknown>;
  /** A raw file body (bad JSON / non-object / unknown-key cases), used verbatim for both. */
  raw?: string;
  /** Shared environment variables applied to both clients. */
  env?: Record<string, string>;
  /** Compare the per-request timeout too (only meaningful when a case sets it explicitly). */
  compareTimeout?: boolean;
}

const cases: Case[] = [
  { name: "defaults (timeouts differ by design)", env: {} },
  { name: "valid file only", compareTimeout: true, fields: { baseUrl: "http://127.0.0.1:9001", timeoutMs: 5000, startupTimeoutMs: 6000, autoStart: false, serverEntry: "pkg", configPath: "c.yaml" } },
  { name: "env URL shadows an invalid file URL", fields: { baseUrl: "ftp://bad" }, env: { HARNESS_ACP_BRIDGE_URL: "http://127.0.0.1:9000" } },
  { name: "env TIMEOUT_MS shadows an invalid file timeout", compareTimeout: true, fields: { timeoutMs: "nope" }, env: { HARNESS_ACP_BRIDGE_TIMEOUT_MS: "1500" } },
  { name: "env AUTOSTART shadows an invalid file autoStart", fields: { autoStart: "maybe" }, env: { HARNESS_ACP_BRIDGE_AUTOSTART: "0" } },
  { name: "env SERVER_ENTRY shadows an invalid file serverEntry", fields: { serverEntry: 5 }, env: { HARNESS_ACP_BRIDGE_SERVER_ENTRY: "pkg" } },
  { name: "env CONFIG shadows a file configPath", fields: { configPath: "file.yaml" }, env: { HARNESS_ACP_BRIDGE_CONFIG: "env.yaml" } },
  { name: "empty env CONFIG clears a file configPath", fields: { configPath: "file.yaml" }, env: { HARNESS_ACP_BRIDGE_CONFIG: "" } },
  { name: "empty env SERVER_ENTRY clears a file serverEntry", fields: { serverEntry: "pkg" }, env: { HARNESS_ACP_BRIDGE_SERVER_ENTRY: "" } },
  { name: "invalid file only (bad URL) fails both", fields: { baseUrl: "ftp://bad" } },
  { name: "non-string file serverEntry fails both", fields: { serverEntry: 5 } },
  { name: "zero file timeout fails both", fields: { timeoutMs: 0 } },
  { name: "relative file configPath resolves against cwd", fields: { configPath: "sub/c.yaml" } },
  // JSON null is an invalid value for the shared numeric fields on *both* clients.
  { name: "null file timeout fails both", fields: { timeoutMs: null } },
  { name: "null file startupTimeoutMs fails both", fields: { startupTimeoutMs: null } },
  { name: "valid env TIMEOUT_MS overrides a null file timeout", compareTimeout: true, fields: { timeoutMs: null }, env: { HARNESS_ACP_BRIDGE_TIMEOUT_MS: "1500" } },
  { name: "valid env STARTUP_TIMEOUT_MS overrides a null file startup", fields: { startupTimeoutMs: null }, env: { HARNESS_ACP_BRIDGE_STARTUP_TIMEOUT_MS: "2500" } },
  // JSON null on the optional/enum fields defaults or clears identically on both clients.
  { name: "null file autoStart defaults true on both", fields: { autoStart: null } },
  { name: "null file baseUrl defaults on both", fields: { baseUrl: null } },
  { name: "null file serverEntry is null on both", fields: { serverEntry: null } },
  { name: "null file configPath is null on both", fields: { configPath: null } },
  { name: "unknown key fails both", raw: JSON.stringify({ command: "node" }) },
  { name: "bad JSON fails both", raw: "{not json" },
  { name: "non-object JSON fails both", raw: "[1,2,3]" },
];

function outcome<T>(fn: () => T): { ok: true; value: T } | { ok: false } {
  try { return { ok: true, value: fn() }; }
  catch { return { ok: false }; }
}

const parity: (name: string, fn: () => void) => void = piLoadSettings ? describe : describe.skip;

parity("MCP readSettings ⇄ Pi loadSettings parity", () => {
  for (const testCase of cases) {
    it(testCase.name, () => {
      const cwd = temp();
      const agentDir = temp();
      const mcpEnv: NodeJS.ProcessEnv = {};
      const piEnv: NodeJS.ProcessEnv = { PI_CODING_AGENT_DIR: agentDir };
      if (testCase.raw !== undefined) {
        const file = join(cwd, "shared.json");
        writeFileSync(file, testCase.raw);
        mcpEnv.HARNESS_ACP_BRIDGE_MCP_CONFIG = file;
        piEnv.PI_ACP_BRIDGE_SETTINGS = file;
      } else if (testCase.fields !== undefined) {
        const mcpFile = join(cwd, "mcp.json");
        writeFileSync(mcpFile, JSON.stringify(testCase.fields));
        const piFile = join(cwd, "pi.json");
        writeFileSync(piFile, piFileText(testCase.fields));
        mcpEnv.HARNESS_ACP_BRIDGE_MCP_CONFIG = mcpFile;
        piEnv.PI_ACP_BRIDGE_SETTINGS = piFile;
      }
      Object.assign(mcpEnv, testCase.env ?? {});
      Object.assign(piEnv, testCase.env ?? {});

      const mcp = outcome(() => readSettings(mcpEnv, cwd));
      const pi = outcome(() => piLoadSettings!(cwd, piEnv));
      expect(pi.ok, `expected both to ${mcp.ok ? "succeed" : "fail"}`).toBe(mcp.ok);
      if (mcp.ok && pi.ok) {
        expect({
          baseUrl: pi.value.baseUrl, startupTimeoutMs: pi.value.startupTimeoutMs, autoStart: pi.value.autoStart,
          serverEntry: pi.value.serverEntry, configPath: pi.value.configPath,
        }).toEqual({
          baseUrl: mcp.value.baseUrl, startupTimeoutMs: mcp.value.startupTimeoutMs, autoStart: mcp.value.autoStart,
          serverEntry: mcp.value.serverEntry, configPath: mcp.value.configPath,
        });
        if (testCase.compareTimeout) expect(pi.value.requestTimeoutMs).toBe(mcp.value.timeoutMs);
      }
    });
  }
});
