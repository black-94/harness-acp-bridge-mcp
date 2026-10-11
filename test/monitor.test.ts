import { describe, expect, it, vi } from "vitest";
import { waitForMessage, type MessageRef } from "../src/monitor.ts";
import type { Decision, InteractionHandler, Question } from "../src/interactions.ts";
import type { BridgeHttpClient } from "../src/http.ts";

const ref: MessageRef = { session_id: "s", message_id: "m" };
const question = (id: string): Question => ({ request_id: id, kind: "permission", title: "t", message: "m", options: [{ optionId: "allow", name: "Allow" }], schema: null });
const waiting = (q: Question) => ({ session_id: "s", message_id: "m", state: "waiting_input", terminal: false, questions: [q] });
const terminal = () => ({ session_id: "s", message_id: "m", state: "failed", terminal: true, questions: [], error: { code: "input_timeout", message: "timeout" } });

function fakeClient(script: (callCount: number) => Record<string, unknown>) {
  const calls: string[] = [];
  let statusCalls = 0;
  const call = vi.fn(async (name: string) => {
    calls.push(name);
    if (name === "message_status") return script(++statusCalls);
    return {};
  });
  return { client: { call } as unknown as BridgeHttpClient, call, calls };
}

const pending = (captured: { signal?: AbortSignal }): InteractionHandler => ({
  resolve: (_q, signal) => { captured.signal = signal; return new Promise<Decision | undefined>((_resolve, reject) => { signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true }); }); },
});

describe("MCP waitForMessage", () => {
  it.each([false, true])("handles an already-aborted signal with cancelOnAbort=%s", async cancelOnAbort => {
    const { client, call } = fakeClient(() => terminal());
    const controller = new AbortController();
    controller.abort();
    await expect(waitForMessage(client, { resolve: async () => undefined }, ref, controller.signal, { pollIntervalMs: 5, cancelOnAbort })).rejects.toThrow();
    expect(call.mock.calls.map(([name]) => name)).toEqual(cancelOnAbort ? ["cancel_message"] : []);
  });
  it("stops wait-only elicitation without cancelling or answering on abort, then resumes", async () => {
    const { client, call } = fakeClient(() => waiting(question("A")));
    const captured: { signal?: AbortSignal } = {};
    const controller = new AbortController();
    const promise = waitForMessage(client, pending(captured), ref, controller.signal, { pollIntervalMs: 5, cancelOnAbort: false });
    await vi.waitFor(() => expect(captured.signal).toBeDefined());
    controller.abort();
    await expect(promise).rejects.toThrow();
    expect(captured.signal?.aborted).toBe(true);
    expect(call.mock.calls.some(([name]) => name === "cancel_message" || name === "answer_question")).toBe(false);
    const status = await waitForMessage(client, { resolve: async () => undefined }, ref, new AbortController().signal, { pollIntervalMs: 5, cancelOnAbort: false });
    expect(status.state).toBe("waiting_input");
  });
  it("returns a terminal status promptly and aborts the pending elicitation", async () => {
    const { client, call } = fakeClient(n => (n === 1 ? waiting(question("A")) : terminal()));
    const captured: { signal?: AbortSignal } = {};
    const status = await waitForMessage(client, pending(captured), ref, new AbortController().signal, { pollIntervalMs: 5 });
    expect(status.terminal).toBe(true);
    expect(captured.signal?.aborted).toBe(true);
    expect(call.mock.calls.some(([name]) => name === "answer_question")).toBe(false);
    expect(call.mock.calls.some(([name]) => name === "cancel_message")).toBe(false);
  });

  it("aborts a superseded elicitation and handles the new question", async () => {
    const { client, call } = fakeClient(n => (n === 1 ? waiting(question("A")) : waiting(question("B"))));
    const captured: { signal?: AbortSignal } = {};
    const handler: InteractionHandler = { resolve: (q, signal) => { captured.signal = signal; return q.request_id === "B" ? Promise.resolve(undefined) : new Promise(() => {}); } };
    const status = await waitForMessage(client, handler, ref, new AbortController().signal, { pollIntervalMs: 5 });
    expect(captured.signal?.aborted).toBe(true);
    expect((status.questions as Question[])[0].request_id).toBe("B");
    expect(call.mock.calls.some(([name]) => name === "answer_question")).toBe(false);
  });

  it("cancels the remote message when the request signal aborts", async () => {
    const { client, call } = fakeClient(() => waiting(question("A")));
    const captured: { signal?: AbortSignal } = {};
    const controller = new AbortController();
    const promise = waitForMessage(client, pending(captured), ref, controller.signal, { pollIntervalMs: 5 });
    await vi.waitFor(() => expect(captured.signal).toBeDefined());
    controller.abort();
    await expect(promise).rejects.toThrow();
    expect(call.mock.calls.some(([name]) => name === "cancel_message")).toBe(true);
  });
});
