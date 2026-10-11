#!/usr/bin/env node
/** Stdio entrypoint for the harness-acp-bridge MCP proxy. */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readSettings } from "./config.js";
import { createBridgeMcpServer } from "./server.js";

async function main(): Promise<void> {
  let settings;
  try { settings = readSettings(); }
  catch (error) {
    process.stderr.write(`harness-acp-bridge-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }
  const server = createBridgeMcpServer(settings);
  await server.connect(new StdioServerTransport());
}

main().catch(error => {
  process.stderr.write(`harness-acp-bridge-mcp: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
