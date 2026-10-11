/** MCP server assembly: bridge operations as tools, with synchronous send/wait. */
import { McpServer, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodType } from "zod";
import { TOOLS, WAIT_TOOL, type BridgeMethod } from "./contract.js";
import { BridgeHttpClient, errorInfo } from "./http.js";
import { ServerLifecycle } from "./lifecycle.js";
import { ElicitationHandler } from "./interactions.js";
import { waitForMessage, type MessageRef } from "./monitor.js";
import { VERSION } from "./version.js";
import type { McpSettings } from "./config.js";

export const SERVER_NAME = "harness-acp-bridge";
const POLL_INTERVAL_MS = 150;

interface ToolConfig { title: string; description: string; inputSchema: ZodType; annotations: { openWorldHint: boolean; readOnlyHint?: boolean; destructiveHint?: boolean } }
type ToolHandler = (args: Record<string, unknown>, extra: { signal: AbortSignal }) => Promise<unknown>;

/** Build the stdio MCP server. It reuses or starts a local server on demand, then proxies. */
export function createBridgeMcpServer(settings: McpSettings): McpServer {
  const client = new BridgeHttpClient(settings);
  const lifecycle = new ServerLifecycle(settings, process.env, process.cwd());
  const server = new McpServer({ name: SERVER_NAME, version: VERSION }, { capabilities: { tools: {} } });
  const interactions = new ElicitationHandler(server, settings.timeoutMs);

  let ensured: Promise<void> | undefined;
  const ensure = (): Promise<void> => {
    if (!ensured) {
      ensured = lifecycle.ensure().then(() => undefined).catch(error => { ensured = undefined; throw error; });
    }
    return ensured;
  };

  const ok = (data: Record<string, unknown>) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
  const fail = (error: unknown) => ({ isError: true, content: [{ type: "text" as const, text: JSON.stringify({ ok: false, error: errorInfo(error) }, null, 2) }] });
  // A terminal status is returned as-is; only `failed` is also flagged as a tool error, so the
  // model sees the failure while the authoritative status/result/error/message ref are preserved.
  const status = (data: Record<string, unknown>) => (data.state === "failed" ? { ...ok(data), isError: true } : ok(data));

  const register = (name: string, config: ToolConfig, handler: ToolHandler): void => {
    server.registerTool(name, config, (async (args: Record<string, unknown>, extra: { signal: AbortSignal }) => {
      try { return await handler(args ?? {}, extra); }
      catch (error) { return fail(error); }
    }) as unknown as ToolCallback<ZodType>);
  };

  for (const tool of TOOLS) {
    const config: ToolConfig = { title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations };
    if (tool.name === "send_message") {
      register(tool.name, config, async (params, extra) => {
        await ensure();
        const data = await client.call("send_message", params, extra.signal);
        if (typeof params.session_id !== "string" || typeof data.message_id !== "string") {
          throw new Error("send_message returned no valid message reference");
        }
        const ref: MessageRef = { session_id: params.session_id, message_id: data.message_id };
        return status(await waitForMessage(client, interactions, ref, extra.signal, { pollIntervalMs: POLL_INTERVAL_MS }));
      });
      continue;
    }
    register(tool.name, config, async (args, extra) => {
      await ensure();
      return ok(await client.call(tool.name as BridgeMethod, args, extra.signal));
    });
  }

  register(WAIT_TOOL.name, { title: WAIT_TOOL.title, description: WAIT_TOOL.description, inputSchema: WAIT_TOOL.inputSchema, annotations: WAIT_TOOL.annotations }, async (args, extra) => {
    await ensure();
    return status(await waitForMessage(client, interactions, args as unknown as MessageRef, extra.signal, { pollIntervalMs: POLL_INTERVAL_MS, cancelOnAbort: false }));
  });

  return server;
}
