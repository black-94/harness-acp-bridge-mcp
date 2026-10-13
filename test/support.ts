import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const serverDir = process.env.ACP_BRIDGE_SERVER_DIR ? resolve(process.env.ACP_BRIDGE_SERVER_DIR) : resolve(here, "../../server");
export const fakeHarness = join(serverDir, "test/fixtures/fake-acp-harness.mjs");
export const mcpMain = resolve(here, "../dist/main.js");

/**
 * The built server module the clients must start. Prefer the repo checkout's build
 * (`../server/dist/index.js`) so integration runs against the in-repo server, and fall back to the
 * installed dependency when the parent checkout is absent (an isolated subrepo CI checkout).
 *
 * The client is protocol-4 only, so a build that still advertises an older protocol is not usable;
 * the server-spawning suites are skipped until the server is rebuilt with the new contract rather
 * than silently running against the old installed dependency.
 */
function distIsProtocol4(distRoot: string): boolean {
  try { return /PROTOCOL_VERSION\s*=\s*4\b|protocol_version:\s*4\b/.test(readFileSync(join(distRoot, "logic", "service.js"), "utf8")); }
  catch { return false; }
}

export function newContractServerEntry(): string | null {
  const repo = join(serverDir, "dist");
  if (distIsProtocol4(repo)) return join(repo, "index.js");
  const installed = join(here, "..", "node_modules", "@black942026", "harness-acp-bridge-server", "dist");
  if (distIsProtocol4(installed)) return join(installed, "index.js");
  return null;
}

/**
 * The `hacpd` CLI of a protocol-4 build (`dist/main.js`), for exercising the PATH-command launch
 * path. Returns null when no protocol-4 build is present (the command suites then skip).
 */
export function newContractServerCli(): string | null {
  const repo = join(serverDir, "dist");
  if (distIsProtocol4(repo) && existsSync(join(repo, "main.js"))) return join(repo, "main.js");
  const installed = join(here, "..", "node_modules", "@black942026", "harness-acp-bridge-server", "dist");
  if (distIsProtocol4(installed) && existsSync(join(installed, "main.js"))) return join(installed, "main.js");
  return null;
}

export function serverAvailable(): boolean {
  return existsSync(fakeHarness) && existsSync(mcpMain) && newContractServerEntry() !== null;
}

/** Bind an ephemeral port, then release it, for a deterministic local baseUrl. */
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

/**
 * A valid protocol-4 server config. Harness commands are no longer configuration: they come from an
 * explicit `command`/`args`/`env` or the target PATH (the integration suite installs PATH wrappers
 * around the fake harness). Built-in adapters need no YAML declarations.
 */
export function bridgeConfig(port: number, stateDir: string): string {
  return JSON.stringify({
    schema_version: 2,
    paths: { state_dir: stateDir },
    server: { host: "127.0.0.1", port },
    sessions: { max_concurrency: 4, reap_interval_seconds: 1 },
    timeouts: { startup_timeout_seconds: 5, request_timeout_seconds: 2, turn_timeout_seconds: 8, turn_cancel_timeout_seconds: 0.5, input_timeout_seconds: 1.5, terminate_grace_seconds: 0.1, remote_cleanup_timeout_seconds: 0.1, authentication_timeout_seconds: 1 },
    authentication: { rate_limit: { enabled: false } },
    // This suite's normal fake harness is CodeBuddy; exercise default Codex in server tests.
    default_harness: "codebuddy",
  });
}

export function registry(dir: string): Record<string, { pid: number | null; log: string; started_at: string }> {
  try { return JSON.parse(readFileSync(join(dir, "servers.json"), "utf8")); }
  catch { return {}; }
}

/** Terminate every server a test started, via the client registry. */
export function killRegistryServers(dir: string): void {
  for (const entry of Object.values(registry(dir))) {
    if (entry.pid) { try { process.kill(entry.pid, "SIGTERM"); } catch { /* already gone */ } }
  }
}
