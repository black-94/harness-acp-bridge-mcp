#!/usr/bin/env node
/**
 * The actual server process, launched by the detached logging supervisor (`bootstrap.js`).
 *
 * Its stdout and stderr are **pipes owned by the supervisor** — never the log file — so every
 * output path (console, `stream.write`, `fs.writeSync`/`fs.writev`, native modules, runtime and
 * dynamic-import diagnostics) is captured and masked before it reaches disk. This process does no
 * redaction itself and never touches the persisted log.
 *
 * It exits when the supervisor goes away (our stdin pipe reaches EOF) or a termination signal
 * arrives, so a killed supervisor can never orphan a running server.
 */
interface ServerInstance { start(): Promise<{ host: string; port: number }>; stop(): Promise<void> }
interface ServerModule {
  HarnessHttpServer: new (config: unknown) => ServerInstance;
  loadConfig: (explicitPath?: string) => unknown;
}

const DEFAULT_SERVER_MODULE = "@black942026/harness-acp-bridge-server";
const entry = process.env.HARNESS_ACP_BRIDGE_SERVER_MODULE || DEFAULT_SERVER_MODULE;
const configPath = process.env.HARNESS_ACP_BRIDGE_CONFIG;

let server: ServerInstance | null = null;
let stopping = false;
let failed = false;

function stop(): void {
  if (stopping) return;
  stopping = true;
  // `server` may still be null if a signal arrives mid-import; stopping is then immediate.
  void Promise.resolve(server ? server.stop() : undefined).then(() => process.exit(failed ? 1 : 0), () => process.exit(1));
}

process.once("SIGTERM", stop);
process.once("SIGINT", stop);
// Parent watchdog: the supervisor holds our stdin open and closes it when it exits, so EOF means
// the supervisor is gone and we must not linger as an orphan.
process.stdin.on("end", stop);
process.stdin.on("close", stop);
process.stdin.resume();

async function main(): Promise<void> {
  const mod = (await import(entry)) as Partial<ServerModule>;
  if (typeof mod.HarnessHttpServer !== "function" || typeof mod.loadConfig !== "function") {
    throw new Error(`server entry ${entry} did not export HarnessHttpServer and loadConfig`);
  }
  server = new mod.HarnessHttpServer(configPath ? mod.loadConfig(configPath) : mod.loadConfig());
  const address = await server.start();
  // Readiness line: the supervisor masks it, and lifecycle uses the answering ping pid to prove
  // this exact process is the one serving the configured address.
  process.stderr.write(`harness-acp-bridge listening at ${address.host}:${address.port}\n`);
}

main().catch(error => {
  failed = true;
  // Ordinary diagnostic text; credentials inside it are masked by the supervisor's redactor.
  process.stderr.write(`harness-acp-bridge bootstrap failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
  // Release the stdin watchdog so a failed import cannot keep this process (and its supervisor)
  // alive; the process then exits once stderr has drained.
  process.stdin.removeAllListeners("end");
  process.stdin.removeAllListeners("close");
  process.stdin.destroy();
});
