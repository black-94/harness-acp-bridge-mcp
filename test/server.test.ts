import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBridgeMcpServer } from "../src/server.ts";
import { TOOL_NAMES } from "../src/contract.ts";

async function stub(handler: (method: string, params: any) => unknown): Promise<{ baseUrl: string; requests: string[]; close: () => Promise<void> }> {
  const requests: string[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      const method = (request.url ?? "").replace(/^\/api\//, "");
      requests.push(method);
      const body = handler(method, JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return { baseUrl: `http://127.0.0.1:${port}`, requests, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

function settingsFor(baseUrl: string) {
  return { baseUrl, timeoutMs: 5000, autoStart: false, serverEntry: null, configPath: null, startupTimeoutMs: 5000 };
}

function text(result: { content: unknown }): unknown {
  const content = Array.isArray(result.content) ? result.content : [];
  const first = content[0] as { type?: string; text?: string } | undefined;
  return first?.type === "text" ? JSON.parse(first.text ?? "null") : null;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });

async function connect(baseUrl: string) {
  const server = createBridgeMcpServer(settingsFor(baseUrl));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);
  cleanups.push(() => mcp.close());
  return mcp;
}

describe("MCP server wiring", () => {
  it("lists the eleven bridge tools plus the two template tools and wait, and proxies a success envelope", async () => {
    const http = await stub(() => ({ ok: true, data: { status: "ok", protocol_version: 4 } }));
    cleanups.push(http.close);
    const mcp = await connect(http.baseUrl);
    const listed = await mcp.listTools();
    expect(listed.tools.map(tool => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(listed.tools).toHaveLength(14);
    expect(listed.tools.map(tool => tool.name)).not.toContain("live_output");
    const result = await mcp.callTool({ name: "ping", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toMatchObject({ status: "ok" });
  });

  it("routes create_template to POST /api/register_template and search_template to its own endpoint", async () => {
    const http = await stub(method => {
      if (method === "ping") return { ok: true, data: { status: "ok", protocol_version: 4 } };
      if (method === "register_template") return { ok: true, data: { template: { name: "t", harness: "codebuddy" } } };
      return { ok: true, data: { templates: [] } };
    });
    cleanups.push(http.close);
    const mcp = await connect(http.baseUrl);
    const created = await mcp.callTool({ name: "create_template", arguments: { template: { name: "t", harness: "codebuddy" } } });
    expect(created.isError).toBeFalsy();
    expect(text(created)).toMatchObject({ template: { name: "t", harness: "codebuddy" } });
    const found = await mcp.callTool({ name: "search_template", arguments: { name: "t" } });
    expect(text(found)).toEqual({ templates: [] });
    // The alias never hits a non-existent create_template endpoint.
    expect(http.requests.filter(method => method !== "ping")).toEqual(["register_template", "search_template"]);
    expect(http.requests).not.toContain("create_template");
  });

  it("returns the server error envelope as a structured tool error", async () => {
    const http = await stub(method => method === "ping"
      ? { ok: true, data: { status: "ok", protocol_version: 4 } }
      : { ok: false, error: { code: "session_not_found", message: "unknown session_id" } });
    cleanups.push(http.close);
    const mcp = await connect(http.baseUrl);
    const result = await mcp.callTool({ name: "message_status", arguments: { session_id: "s", message_id: "m" } });
    expect(result.isError).toBe(true);
    expect(text(result)).toEqual({ ok: false, error: { code: "session_not_found", message: "unknown session_id" } });
  });

  it("rejects arguments the schema does not allow before calling the server", async () => {
    const http = await stub(() => ({ ok: true, data: { status: "ok", protocol_version: 4 } }));
    cleanups.push(http.close);
    const mcp = await connect(http.baseUrl);
    // `method_id` is no longer accepted by `authenticate`; the strict schema must reject it.
    const result = await mcp.callTool({ name: "authenticate", arguments: { session_id: "s", method_id: "agent" } });
    expect(result.isError).toBe(true);
    expect(http.requests).not.toContain("authenticate");
  });

  it.each(["wait", "send_message"])("uses the correct abort policy for %s", async name => {
    let terminal = false;
    const http = await stub(method => {
      if (method === "ping") return { ok: true, data: { status: "ok", protocol_version: 4 } };
      if (method === "send_message") return { ok: true, data: { message_id: "m1" } };
      return { ok: true, data: { session_id: "s1", message_id: "m1", state: terminal ? "completed" : "running", terminal, questions: [], result: terminal ? { text: "done" } : undefined } };
    });
    cleanups.push(http.close);
    const mcp = await connect(http.baseUrl);
    const controller = new AbortController();
    const args = name === "wait" ? { session_id: "s1", message_id: "m1" } : { session_id: "s1", text: "hello" };
    const promise = mcp.callTool({ name, arguments: args }, undefined, { signal: controller.signal });
    await vi.waitFor(() => expect(http.requests).toContain("message_status"));
    controller.abort();
    await expect(promise).rejects.toThrow();
    if (name === "send_message") {
      await vi.waitFor(() => expect(http.requests.filter(method => method === "cancel_message")).toHaveLength(1));
    } else {
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(http.requests).not.toContain("cancel_message");
      terminal = true;
      const resumed = await mcp.callTool({ name: "wait", arguments: { session_id: "s1", message_id: "m1" } });
      expect(text(resumed)).toMatchObject({ terminal: true, result: { text: "done" } });
      expect(http.requests).not.toContain("send_message");
    }
  });

  it("flags a failed terminal message as a tool error while preserving its status", async () => {
    const http = await stub(method => {
      if (method === "ping") return { ok: true, data: { status: "ok", protocol_version: 4 } };
      if (method === "send_message") return { ok: true, data: { message_id: "m1" } };
      return { ok: true, data: { session_id: "s1", message_id: "m1", state: "failed", terminal: true, questions: [], error: { code: "invalid_json", message: "bad harness output" }, result: { text: "", reasoning: "", tool_calls: [], stop_reason: null, raw_result: null } } };
    });
    cleanups.push(http.close);
    const mcp = await connect(http.baseUrl);
    const result = await mcp.callTool({ name: "send_message", arguments: { session_id: "s1", text: "x" } });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatchObject({ state: "failed", terminal: true, message_id: "m1", error: { code: "invalid_json" } });
  });

  it("marks a terminal status carrying an error as a tool error; a plain cancel is not", async () => {
    let withError = true;
    const http = await stub(method => {
      if (method === "ping") return { ok: true, data: { status: "ok", protocol_version: 4 } };
      return { ok: true, data: { session_id: "s1", message_id: "m1", state: "cancelled", terminal: true, questions: [], ...(withError ? { error: { code: "input_timeout", message: "authentication question timed out" } } : {}) } };
    });
    cleanups.push(http.close);
    const mcp = await connect(http.baseUrl);
    const failed = await mcp.callTool({ name: "wait", arguments: { session_id: "s1", message_id: "m1" } });
    expect(failed.isError).toBe(true);
    expect(text(failed)).toMatchObject({ state: "cancelled", error: { code: "input_timeout" } });

    withError = false;
    const plain = await mcp.callTool({ name: "wait", arguments: { session_id: "s1", message_id: "m1" } });
    expect(plain.isError).toBeFalsy();
    expect(text(plain)).toMatchObject({ state: "cancelled" });
  });

  it("flags a rate-limited authentication flow as a tool error while preserving its state", async () => {
    const http = await stub(method => {
      if (method === "ping") return { ok: true, data: { status: "ok", protocol_version: 4 } };
      if (method === "authenticate") return { ok: true, data: { session_id: "s1", state: "authentication_rate_limited", terminal: true, questions: [], error: { code: "authentication_rate_limited", message: "rate limited", detail: { retry_after_seconds: 10 } } } };
      return { ok: true, data: {} };
    });
    cleanups.push(http.close);
    const mcp = await connect(http.baseUrl);
    const result = await mcp.callTool({ name: "authenticate", arguments: { session_id: "s1" } });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatchObject({ state: "authentication_rate_limited", terminal: true, error: { code: "authentication_rate_limited" } });
  });

  it("returns the authentication flow snapshot from the authenticate tool", async () => {
    const http = await stub(method => {
      if (method === "ping") return { ok: true, data: { status: "ok", protocol_version: 4 } };
      if (method === "authenticate") return { ok: true, data: { session_id: "s1", state: "ready", terminal: true, questions: [], authenticated: true } };
      return { ok: true, data: {} };
    });
    cleanups.push(http.close);
    const mcp = await connect(http.baseUrl);
    const result = await mcp.callTool({ name: "authenticate", arguments: { session_id: "s1" } });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toMatchObject({ state: "ready", terminal: true, authenticated: true });
  });

  it("preserves the structured authentication_required envelope from create_session", async () => {
    const detail = { session_id: "s-auth", next_action: { method: "authenticate", params: { session_id: "s-auth" } } };
    const http = await stub(method => {
      if (method === "ping") return { ok: true, data: { status: "ok", protocol_version: 4 } };
      if (method === "create_session") return { ok: false, error: { code: "authentication_required", message: "Authentication is required.", detail } };
      return { ok: true, data: {} };
    });
    cleanups.push(http.close);
    const mcp = await connect(http.baseUrl);
    const result = await mcp.callTool({ name: "create_session", arguments: { cwd: "/repo", model_id: "m" } });
    expect(result.isError).toBe(true);
    // The model-readable error retains session_id and next_action, not just the message.
    expect(text(result)).toMatchObject({ ok: false, error: { code: "authentication_required", detail } });
  });
});
