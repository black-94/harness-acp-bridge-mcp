import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const serverDir = process.env.ACP_BRIDGE_SERVER_DIR ? resolve(process.env.ACP_BRIDGE_SERVER_DIR) : resolve(here, "../../server");
export const fakeHarness = join(serverDir, "test/fixtures/fake-acp-harness.mjs");
export const mcpMain = resolve(here, "../dist/main.js");

export function serverAvailable(): boolean {
  return existsSync(fakeHarness) && existsSync(mcpMain);
}

/** Bind an ephemeral port, then release it, for a deterministic local baseUrl. */
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

export function bridgeConfig(port: number, stateDir: string): string {
  return JSON.stringify({
    schema_version: 2,
    paths: { state_dir: stateDir },
    server: { host: "127.0.0.1", port },
    sessions: { max_concurrency: 4, reap_interval_seconds: 1 },
    timeouts: { startup_timeout_seconds: 5, request_timeout_seconds: 2, turn_timeout_seconds: 8, turn_cancel_timeout_seconds: 0.5, input_timeout_seconds: 1.5, terminate_grace_seconds: 0.1, remote_cleanup_timeout_seconds: 0.1, authentication_timeout_seconds: 1 },
    authentication: { rate_limit: { enabled: false } },
    default_harness: "codebuddy",
    harnesses: {
      codebuddy: {
        command: process.execPath,
        args: [fakeHarness],
        models: [{ id: "fake-model", thinking_levels: ["low", "high"] }, { id: "fake-model-2" }],
      },
    },
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
