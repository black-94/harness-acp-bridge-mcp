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
  it("lists the twelve bridge tools plus wait and proxies a success envelope", async () => {
    const http = await stub(() => ({ ok: true, data: { status: "ok", protocol_version: 2 } }));
    cleanups.push(http.close);
    const mcp = await connect(http.baseUrl);
    const listed = await mcp.listTools();
    expect(listed.tools.map(tool => tool.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(listed.tools).toHaveLength(13);
    const result = await mcp.callTool({ name: "ping", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toMatchObject({ status: "ok" });
  });

  it("returns the server error envelope as a structured tool error", async () => {
    const http = await stub(method => method === "ping"
      ? { ok: true, data: { status: "ok", protocol_version: 2 } }
      : { ok: false, error: { code: "session_not_found", message: "unknown session_id" } });
    cleanups.push(http.close);
    const mcp = await connect(http.baseUrl);
    const result = await mcp.callTool({ name: "message_status", arguments: { session_id: "s", message_id: "m" } });
    expect(result.isError).toBe(true);
    expect(text(result)).toEqual({ ok: false, error: { code: "session_not_found", message: "unknown session_id" } });
  });

  it("rejects arguments the schema does not allow before calling the server", async () => {
    const http = await stub(() => ({ ok: true, data: { status: "ok", protocol_version: 2 } }));
    cleanups.push(http.close);
    const mcp = await connect(http.baseUrl);
    const result = await mcp.callTool({ name: "live_output", arguments: { session_id: "s", offset: 3 } });
    expect(result.isError).toBe(true);
    expect(http.requests).not.toContain("live_output");
  });

  it.each(["wait", "send_message"])("uses the correct abort policy for %s", async name => {
    let terminal = false;
    const http = await stub(method => {
      if (method === "ping") return { ok: true, data: { status: "ok", protocol_version: 2 } };
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
      if (method === "ping") return { ok: true, data: { status: "ok", protocol_version: 2 } };
      if (method === "send_message") return { ok: true, data: { message_id: "m1" } };
      return { ok: true, data: { session_id: "s1", message_id: "m1", state: "failed", terminal: true, questions: [], error: { code: "invalid_json", message: "bad harness output" }, result: { text: "", reasoning: "", tool_calls: [], stop_reason: null, raw_result: null } } };
    });
    cleanups.push(http.close);
    const mcp = await connect(http.baseUrl);
    const result = await mcp.callTool({ name: "send_message", arguments: { session_id: "s1", text: "x" } });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatchObject({ state: "failed", terminal: true, message_id: "m1", error: { code: "invalid_json" } });
  });
});
