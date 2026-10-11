/**
 * Connection settings for the MCP proxy.
 *
 * The proxy is a thin HTTP client for an already-running harness-acp-bridge server, but it can
 * start one *local* instance on demand (see `lifecycle.ts`). It never accepts a command or
 * argv pass-through: only the server URL, timing, and a managed server entry/config belong
 * here. Environment variables win over the JSON file.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_BASE_URL = "http://127.0.0.1:8787";
export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
export const DEFAULT_SERVER_MODULE = "@black942026/harness-acp-bridge-server";

export interface McpSettings {
  baseUrl: string;
  timeoutMs: number;
  /** Start a local server when the configured one is unreachable (loopback only). */
  autoStart: boolean;
  /** Explicit server module/path, or null to resolve the installed server dependency. */
  serverEntry: string | null;
  /** Explicit server YAML config path, or null to honor HARNESS_ACP_BRIDGE_CONFIG/defaults. */
  configPath: string | null;
  startupTimeoutMs: number;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate an HTTP(S) base URL without a query, fragment, or embedded credentials. */
export function normalizeBaseUrl(value: string, source: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error(`${source}: baseUrl is not a valid URL: ${JSON.stringify(value)}`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${source}: baseUrl must use http or https`);
  }
  if (url.username || url.password) throw new Error(`${source}: baseUrl must not embed credentials`);
  if (url.search || url.hash) throw new Error(`${source}: baseUrl must not contain a query or fragment`);
  return url.toString().replace(/\/$/, "");
}

function positiveInteger(value: unknown, source: string, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 2_147_483_647) {
    throw new Error(`${source}: ${name} must be a positive integer`);
  }
  return value as number;
}

function booleanSetting(value: unknown, source: string, name: string): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "boolean") return value;
  if (value === "0" || value === "false") return false;
  if (value === "1" || value === "true") return true;
  throw new Error(`${source}: ${name} must be a boolean`);
}

const FILE_KEYS = ["baseUrl", "timeoutMs", "autoStart", "serverEntry", "configPath", "startupTimeoutMs"] as const;

/** Resolve the proxy settings from an optional JSON file plus environment overrides. */
export function readSettings(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): McpSettings {
  let file: Record<string, unknown> = {};
  const path = env.HARNESS_ACP_BRIDGE_MCP_CONFIG;
  if (path) {
    const resolved = resolve(path);
    let text: string;
    try { text = readFileSync(resolved, "utf8"); }
    catch (error) { throw new Error(`could not read ${resolved}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`); }
    let data: unknown;
    try { data = JSON.parse(text); }
    catch { throw new Error(`${resolved}: invalid JSON`); }
    if (!isRecord(data)) throw new Error(`${resolved}: expected an object`);
    for (const key of Object.keys(data)) {
      if (!(FILE_KEYS as readonly string[]).includes(key)) throw new Error(`${resolved}: unknown setting ${key}`);
    }
    file = data;
  }

  const rawBaseUrl = env.HARNESS_ACP_BRIDGE_URL ?? file.baseUrl ?? DEFAULT_BASE_URL;
  if (typeof rawBaseUrl !== "string" || !rawBaseUrl.trim()) throw new Error("baseUrl must be a non-empty string");
  const baseUrl = normalizeBaseUrl(rawBaseUrl.trim(), "settings");

  const timeoutMs = env.HARNESS_ACP_BRIDGE_TIMEOUT_MS !== undefined
    ? positiveInteger(Number(env.HARNESS_ACP_BRIDGE_TIMEOUT_MS), "environment", "HARNESS_ACP_BRIDGE_TIMEOUT_MS")
    : file.timeoutMs !== undefined ? positiveInteger(file.timeoutMs, "settings", "timeoutMs") : DEFAULT_TIMEOUT_MS;

  const startupTimeoutMs = env.HARNESS_ACP_BRIDGE_STARTUP_TIMEOUT_MS !== undefined
    ? positiveInteger(Number(env.HARNESS_ACP_BRIDGE_STARTUP_TIMEOUT_MS), "environment", "HARNESS_ACP_BRIDGE_STARTUP_TIMEOUT_MS")
    : file.startupTimeoutMs !== undefined ? positiveInteger(file.startupTimeoutMs, "settings", "startupTimeoutMs") : DEFAULT_STARTUP_TIMEOUT_MS;

  const autoStart = booleanSetting(env.HARNESS_ACP_BRIDGE_AUTOSTART ?? file.autoStart, "settings", "autoStart");

  const serverEntry = stringOrNull(env.HARNESS_ACP_BRIDGE_SERVER_ENTRY ?? file.serverEntry, "serverEntry");
  const rawConfigPath = stringOrNull(env.HARNESS_ACP_BRIDGE_CONFIG ?? file.configPath, "configPath");
  // The bootstrap runs with its own cwd, so resolve the server config against the original cwd.
  const configPath = rawConfigPath === null ? null : resolve(cwd, rawConfigPath);

  return { baseUrl, timeoutMs, autoStart, serverEntry, configPath, startupTimeoutMs };
}

function stringOrNull(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

/** True when the URL points at the local machine, so starting a local server is safe. */
export function isLoopback(baseUrl: string): boolean {
  const host = new URL(baseUrl).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "::1" || host === "0.0.0.0" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * Import specifier for an explicit server entry, resolved against `cwd`.
 *
 * A `file:` URL is returned unchanged (never re-wrapped in `pathToFileURL`); an absolute or
 * `./`/`../` path becomes a `file:` URL; a bare package name returns `null` (imported as-is).
 * The entry must export `HarnessHttpServer`/`loadConfig` (the server package index), not a CLI.
 */
export function serverEntrySpecifier(entry: string, cwd: string): string | null {
  if (entry.startsWith("file:")) return entry;
  if (isAbsolute(entry)) return pathToFileURL(entry).href;
  if (entry.startsWith("./") || entry.startsWith("../")) return pathToFileURL(resolve(cwd, entry)).href;
  return null;
}
