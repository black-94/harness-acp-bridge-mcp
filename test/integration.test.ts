/**
 * End-to-end MCP proxy tests: a real stdio client, the proxy, a real harness-acp-bridge HTTP
 * server it starts on demand (the installed server dependency), and the server's fake ACP
 * harness. Skips when the proxy or the server fixture is not built. No paid model/Docker/SSH.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bridgeConfig, freePort, killRegistryServers, mcpMain, newContractServerEntry, registry, serverAvailable } from "./support.ts";

interface CallResult { content?: Array<{ type?: string; text?: string }>; isError?: boolean }
function payload(result: CallResult): any {
  return JSON.parse(result.content?.find(part => part.type === "text")?.text ?? "null");
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await client.callTool({ name, arguments: args }) as CallResult;
  if (result.isError) throw new Error(`tool ${name} failed: ${JSON.stringify(payload(result))}`);
  return payload(result);
}

describe.runIf(serverAvailable())("MCP proxy with autostart, elicitation and sync wait", () => {
  let dir: string;
  let clientDir: string;
  let baseUrl: string;
  let capable: Client;
  let capableTransport: StdioClientTransport;
  let session: string;
  const elicitations: string[] = [];

  const proxyEnv = (): Record<string, string> => ({
    ...getDefaultEnvironment(),
    HARNESS_ACP_BRIDGE_URL: baseUrl,
    // Start the in-repo server build (not the installed dependency).
    HARNESS_ACP_BRIDGE_SERVER_ENTRY: newContractServerEntry()!,
    HARNESS_ACP_BRIDGE_CONFIG: join(dir, "config.yaml"),
    HARNESS_ACP_BRIDGE_CLIENT_DIR: clientDir,
    HARNESS_ACP_BRIDGE_TIMEOUT_MS: "15000",
    HARNESS_ACP_BRIDGE_STARTUP_TIMEOUT_MS: "20000",
  });

  const spawnProxy = async (
    capabilities: Record<string, unknown> | undefined,
    onElicit?: (request: unknown, extra: unknown) => unknown,
  ): Promise<{ client: Client; transport: StdioClientTransport }> => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [mcpMain], env: proxyEnv(), stderr: "pipe" });
    const client = new Client({ name: "e2e", version: "0.0.0" }, capabilities ? { capabilities: capabilities as never } : undefined);
    if (onElicit) client.setRequestHandler(ElicitRequestSchema, async (request, extra) => onElicit(request, extra) as never);
    await client.connect(transport);
    return { client, transport };
  };

  const connectProxy = async (elicitation: boolean): Promise<{ client: Client; transport: StdioClientTransport }> => {
    if (!elicitation) return spawnProxy(undefined);
    return spawnProxy({ elicitation: {} }, request => {
      // The SDK hands the response-validation wrapper the full request envelope; accept either shape.
      const params = ((request as { params?: unknown }).params ?? request) as { message?: string; requestedSchema?: { properties?: Record<string, any> } };
      const properties = (params.requestedSchema?.properties ?? {}) as Record<string, any>;
      elicitations.push(String(params.message ?? ""));
      if (properties.option_id) return { action: "accept", content: { option_id: "allow_once" } };
      const content: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(properties)) {
        content[key] = value.type === "boolean" ? true : value.type === "number" || value.type === "integer" ? 1 : Array.isArray(value.enum) ? value.enum[0] : "blue";
      }
      return { action: "accept", content };
    });
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "mcp-e2e-"));
    clientDir = join(dir, "client");
    const port = await freePort();
    writeFileSync(join(dir, "config.yaml"), bridgeConfig(port, join(dir, "sessions")));
    baseUrl = `http://127.0.0.1:${port}`;
    ({ client: capable, transport: capableTransport } = await connectProxy(true));
  }, 40000);

  afterAll(async () => {
    await capable?.close().catch(() => {});
    killRegistryServers(clientDir);
    // The detached server keeps writing its log briefly after SIGTERM; retry the recursive remove.
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("lists the eleven operations plus wait", async () => {
    const listed = await capable.listTools();
    expect(listed.tools.map(tool => tool.name).sort()).toEqual([
      "answer_question", "auth_status", "authenticate", "cancel_message", "close_session", "create_session",
      "message_status", "ping", "search_harness", "send_message", "set_session_options", "wait",
    ]);
  });

  it("autostarts the local server when none is running, then pings it", async () => {
    expect(registry(clientDir)).toEqual({});
    expect(await call(capable, "ping")).toMatchObject({ status: "ok", protocol_version: 3 });
    expect(Object.keys(registry(clientDir))).toEqual([baseUrl]);
    expect(await call(capable, "search_harness")).toHaveProperty("harnesses.codebuddy");
  });

  it("creates a session and synchronously completes a message", async () => {
    session = (await call(capable, "create_session", { cwd: dir, model_id: "fake-model" })).session_id;
    const status = await call(capable, "send_message", { session_id: session, text: "hello 中文😀" });
    expect(status.terminal).toBe(true);
    expect(status.result.text).toBe("echo:hello 中文😀");
  });

  it("auto-answers a permission request through elicitation without approving by default", async () => {
    const status = await call(capable, "send_message", { session_id: session, text: "permission" });
    expect(status.terminal).toBe(true);
    expect(status.result.text).toContain("[allowed:allow_once]");
    expect(elicitations.some(message => /Allow this action/.test(message))).toBe(true);
  });

  it("auto-answers a form elicitation with the schema's fields", async () => {
    const status = await call(capable, "send_message", { session_id: session, text: "elicit-form" });
    expect(status.terminal).toBe(true);
    expect(status.result.text).toContain('[elicited:{"value":"blue"}]');
  });

  it("flags a real failed message as a tool error while preserving its status", async () => {
    const result = await capable.callTool({ name: "send_message", arguments: { session_id: session, text: "bad-json" } }) as CallResult;
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ state: "failed", terminal: true, error: { code: "invalid_json" } });
  });

  it("returns waiting_input for a schema it cannot represent and answers it explicitly", async () => {
    const pending = await call(capable, "send_message", { session_id: session, text: "info" });
    expect(pending.terminal).toBe(false);
    expect(pending.state).toBe("waiting_input");
    await call(capable, "answer_question", { session_id: session, message_id: pending.message_id, request_id: pending.questions[0].request_id, content: { value: "Ada" } });
    const done = await call(capable, "wait", { session_id: session, message_id: pending.message_id });
    expect(done.terminal).toBe(true);
    expect(done.result.text).toContain('[info:{"value":"Ada"}]');
  });

  it("does not send a form when the client advertises only url elicitation", async () => {
    const { client } = await spawnProxy({ elicitation: { url: {} } });
    try {
      const echoSession = (await call(client, "create_session", { cwd: dir, model_id: "fake-model" })).session_id;
      const pending = await call(client, "send_message", { session_id: echoSession, text: "permission" });
      expect(pending.terminal).toBe(false);
      expect(pending.state).toBe("waiting_input");
      await call(client, "cancel_message", { session_id: echoSession, message_id: pending.message_id });
      await call(client, "close_session", { session_id: echoSession });
    } finally { await client.close().catch(() => {}); }
  });

  it("returns a terminal result promptly even while an elicitation is hanging", async () => {
    const { client } = await spawnProxy({ elicitation: {} }, () => new Promise(() => { /* never resolves */ }));
    try {
      const echoSession = (await call(client, "create_session", { cwd: dir, model_id: "fake-model" })).session_id;
      const started = Date.now();
      const result = await client.callTool({ name: "send_message", arguments: { session_id: echoSession, text: "permission" } }) as CallResult;
      expect(result.isError).toBe(true);
      const status = payload(result);
      expect(status.terminal).toBe(true);
      expect(status.state).toBe("failed");
      // The proxy abandons the pending elicitation at the input timeout instead of blocking.
      expect(Date.now() - started).toBeLessThan(7000);
      await call(client, "close_session", { session_id: echoSession });
    } finally { await client.close().catch(() => {}); }
  });

  it("returns the terminal result from a normal message (no live_output endpoint)", async () => {
    const status = await call(capable, "send_message", { session_id: session, text: "fragments😀" });
    expect(status.terminal).toBe(true);
    expect(status.result.text).toBe("echo:fragments😀");
  });

  it("drives a real unauthenticated session through the auth flow to ready", async () => {
    const messages: string[] = [];
    const { client } = await spawnProxy({ elicitation: {} }, (request: unknown) => {
      const params = ((request as { params?: unknown }).params ?? request) as { message?: string; requestedSchema?: { properties?: Record<string, any> } };
      const properties = (params.requestedSchema?.properties ?? {}) as Record<string, any>;
      messages.push(String(params.message ?? ""));
      if (properties.method_id) return { action: "accept", content: { method_id: "device" } };
      if (properties.opened) return { action: "accept", content: { opened: true } };
      const content: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(properties)) content[key] = value.type === "boolean" ? true : "blue";
      return { action: "accept", content };
    });
    try {
      // A login-gated harness: create_session surfaces the structured authentication_required error.
      const created = await client.callTool({ name: "create_session", arguments: { cwd: dir, model_id: "fake-model", harness: "codex" } }) as CallResult;
      expect(created.isError).toBe(true);
      const failure = payload(created);
      expect(failure.error.code).toBe("authentication_required");
      const sessionId = failure.error.detail.session_id as string;
      expect(typeof sessionId).toBe("string");

      const ready = await call(client, "authenticate", { session_id: sessionId });
      expect(ready).toMatchObject({ state: "ready", terminal: true, authenticated: true });
      // The unsupported candidate, the full verification URL, and the device code were all shown.
      expect(messages.some(message => message.includes("Not supported in harness_acp_bridge"))).toBe(true);
      expect(messages.some(message => message.includes("https://example.test/device"))).toBe(true);
      expect(messages.some(message => message.includes("ABCD-1234"))).toBe(true);

      const status = await call(client, "auth_status", { session_id: sessionId });
      expect(status.authenticated).toBe(true);
      await call(client, "close_session", { session_id: sessionId });
    } finally { await client.close().catch(() => {}); }
  });

  it("closes the session", async () => {
    expect((await call(capable, "close_session", { session_id: session })).session_id).toBe(session);
  });

  it("reuses one server; without elicitation returns waiting_input, then answer+wait and cancel", async () => {
    const recordBefore = registry(clientDir);
    const { client } = await connectProxy(false);
    try {
      const echoSession = (await call(client, "create_session", { cwd: dir, model_id: "fake-model" })).session_id;

      // No elicitation: send_message returns waiting_input with the original question.
      const pending = await call(client, "send_message", { session_id: echoSession, text: "permission" });
      expect(pending.terminal).toBe(false);
      expect(pending.state).toBe("waiting_input");
      const question = pending.questions[0];
      expect(typeof question.request_id).toBe("string");
      await call(client, "answer_question", { session_id: echoSession, message_id: pending.message_id, request_id: question.request_id, option_id: "allow_once" });
      const done = await call(client, "wait", { session_id: echoSession, message_id: pending.message_id });
      expect(done.terminal).toBe(true);
      expect(done.result.text).toContain("[allowed:allow_once]");

      // Cancellation: cancel a message that is waiting for input.
      const second = await call(client, "send_message", { session_id: echoSession, text: "permission" });
      expect(second.state).toBe("waiting_input");
      const cancelled = await call(client, "cancel_message", { session_id: echoSession, message_id: second.message_id });
      expect(cancelled.terminal).toBe(true);
      expect(cancelled.state).toBe("cancelled");

      expect(registry(clientDir)).toEqual(recordBefore);
      await call(client, "close_session", { session_id: echoSession });
    } finally {
      await client.close().catch(() => {});
    }
  });
});
