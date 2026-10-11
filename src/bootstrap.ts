#!/usr/bin/env node
/**
 * Detached server bootstrap.
 *
 * Spawned by `lifecycle.ts` only when no compatible server is listening on a loopback address.
 * It loads the installed server package (or an explicit entry) and starts the HTTP server,
 * writing diagnostics to stderr (redirected to a client-owned log). It has no arguments of its
 * own; the module and config come from the environment set by the client.
 */

interface ServerInstance { start(): Promise<{ host: string; port: number }>; stop(): Promise<void> }
interface ServerModule {
  HarnessHttpServer: new (config: unknown) => ServerInstance;
  loadConfig: (explicitPath?: string) => unknown;
}

async function main(): Promise<void> {
  const entry = process.env.HARNESS_ACP_BRIDGE_SERVER_MODULE || "@black942026/harness-acp-bridge-server";
  const mod = (await import(entry)) as Partial<ServerModule>;
  if (typeof mod.HarnessHttpServer !== "function" || typeof mod.loadConfig !== "function") {
    throw new Error(`server entry ${entry} did not export HarnessHttpServer and loadConfig`);
  }
  const configPath = process.env.HARNESS_ACP_BRIDGE_CONFIG;
  const server = new mod.HarnessHttpServer(configPath ? mod.loadConfig(configPath) : mod.loadConfig());
  const address = await server.start();
  process.stderr.write(`harness-acp-bridge listening at ${address.host}:${address.port}\n`);
  const stop = (): void => { void server.stop().then(() => process.exit(0)).catch(() => process.exit(1)); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

main().catch(error => {
  process.stderr.write(`harness-acp-bridge bootstrap failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
