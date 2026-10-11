import { describe, expect, it, vi } from "vitest";
import { BridgeError, BridgeHttpClient } from "../src/http.ts";

const BASE = "http://127.0.0.1:8787";

function respond(body: unknown, status = 200): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("BridgeHttpClient", () => {
  it("posts the parameter object and unwraps a success envelope", async () => {
    const fetchImpl = vi.fn(async () => respond({ ok: true, data: { message_id: "m1" } }));
    const client = new BridgeHttpClient({ baseUrl: BASE, timeoutMs: 1000, fetchImpl: fetchImpl as unknown as typeof fetch });
    const data = await client.call("send_message", { session_id: "s", text: "hi" });
    expect(data).toEqual({ message_id: "m1" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(`${BASE}/api/send_message`);
    expect((init as RequestInit).method).toBe("POST");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ session_id: "s", text: "hi" });
  });

  it("treats only ok:true as success, even on HTTP 200, and maps the error envelope", async () => {
    const errorBody = { ok: false, error: { code: "busy", message: "session is running", detail: { state: "running" } } };
    const client = new BridgeHttpClient({
      baseUrl: BASE, timeoutMs: 1000,
      fetchImpl: (async () => respond(errorBody, 200)) as unknown as typeof fetch,
    });
    await expect(client.call("send_message", { session_id: "s", text: "x" })).rejects.toMatchObject({
      code: "busy", message: "session is running", detail: { state: "running" },
    });
  });

  it("carries the HTTP status only when the envelope is unusable", async () => {
    const client = new BridgeHttpClient({
      baseUrl: BASE, timeoutMs: 1000,
      fetchImpl: (async () => respond("not json", 502)) as unknown as typeof fetch,
    });
    await expect(client.call("ping")).rejects.toMatchObject({ code: "invalid_response" });
    try { await client.call("ping"); } catch (error) { expect(String(error)).toContain("HTTP 502"); }
  });

  it.each([
    ["a non-object envelope", "42"],
    ["ok:true without object data", JSON.stringify({ ok: true, data: "x" })],
    ["an unknown envelope", JSON.stringify({ hello: "world" })],
    ["ok:false without an error object", JSON.stringify({ ok: false })],
  ])("rejects %s", async (_label, body) => {
    const client = new BridgeHttpClient({
      baseUrl: BASE, timeoutMs: 1000,
      fetchImpl: (async () => respond(body)) as unknown as typeof fetch,
    });
    await expect(client.call("ping")).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("reports an unreachable server without echoing the request body", async () => {
    const fetchImpl = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const client = new BridgeHttpClient({ baseUrl: BASE, timeoutMs: 1000, fetchImpl });
    let error: unknown;
    try { await client.call("send_message", { session_id: "s", text: "top-secret-prompt" }); }
    catch (cause) { error = cause; }
    expect(error).toBeInstanceOf(BridgeError);
    expect(error).toMatchObject({ code: "network_error" });
    expect(String(error)).toContain(BASE);
    expect(String(error)).not.toContain("top-secret-prompt");
  });

  it("times out a stalled request", async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })) as unknown as typeof fetch;
    const client = new BridgeHttpClient({ baseUrl: BASE, timeoutMs: 20, fetchImpl });
    await expect(client.call("ping")).rejects.toMatchObject({ code: "request_timeout" });
  });

  it("distinguishes a caller abort from a timeout", async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })) as unknown as typeof fetch;
    const client = new BridgeHttpClient({ baseUrl: BASE, timeoutMs: 60_000, fetchImpl });
    const controller = new AbortController();
    const pending = client.call("message_status", { session_id: "s", message_id: "m" }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "request_aborted" });
  });
});
