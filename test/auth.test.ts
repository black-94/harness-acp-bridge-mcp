/**
 * Authentication-workflow driver tests (MCP proxy).
 *
 * The proxy must elicit every server-provided question (never choosing a method or a token
 * itself), submit each answer as a session-scoped `answer_question` (no `message_id`), and poll
 * until the flow is terminal. A user decline/cancel/timeout is a real answer; a local abort only
 * detaches and never cancels a message.
 */
import { describe, expect, it, vi } from "vitest";
import { authenticateSession } from "../src/auth.ts";
import type { Decision, InteractionHandler, Question } from "../src/interactions.ts";
import type { BridgeHttpClient } from "../src/http.ts";

const ref = { session_id: "s1" };

const methodQuestion = (): Question => ({
  request_id: "q-method", kind: "information", title: "Choose an authentication method",
  message: "Choose one supported authentication method. Advertised candidates:\n[{\"id\":\"agent\",\"supported\":true},{\"id\":\"legacy\",\"type\":\"browser\",\"supported\":false,\"description\":\"Not supported in harness_acp_bridge\"}]",
  options: [], schema: { type: "object", properties: { method_id: { type: "string", enum: ["agent"] } }, required: ["method_id"], additionalProperties: false },
});

const tokenQuestion = (): Question => ({
  request_id: "q-token", kind: "information", title: "Enter token",
  message: "Paste the harness token to finish authentication.",
  options: [], schema: { type: "object", properties: { token: { type: "string", minLength: 1 } }, required: ["token"], additionalProperties: false },
});

const urlQuestion = (url: string): Question => ({
  request_id: "q-url", kind: "elicitation", title: "Complete authentication",
  message: `Open this URL and complete authentication, then confirm here: ${url}`,
  options: [], schema: { type: "object", properties: { opened: { type: "boolean", enum: [true] } }, required: ["opened"], additionalProperties: false },
});

interface Flow {
  client: BridgeHttpClient;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  state: { terminal: boolean; question: Question | undefined; answered: number };
}

function flow(questions: Question[]): Flow {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const state = { terminal: false, question: undefined as Question | undefined, answered: 0 };
  const current = () => questions[state.answered];
  const snapshot = () => ({
    session_id: "s1", state: state.terminal ? "ready" : "waiting_input", terminal: state.terminal,
    questions: state.terminal || !state.question ? [] : [state.question],
    candidates: [{ id: "agent", name: "Agent", type: "agent", supported: true }, { id: "legacy", name: "Legacy", type: "browser", supported: false, description: "Not supported in harness_acp_bridge" }],
    ...(state.terminal ? { authenticated: true } : {}),
  });
  const client = {
    async call(name: string, args: Record<string, unknown> = {}) {
      calls.push({ name, args });
      if (name === "authenticate") { state.question = current(); return snapshot(); }
      if (name === "auth_status") return snapshot();
      if (name === "answer_question") {
        state.answered += 1;
        state.question = current();
        if (state.question === undefined) state.terminal = true;
        return snapshot();
      }
      return {};
    },
  } as unknown as BridgeHttpClient;
  return { client, calls, state };
}

const answering = (fn: (question: Question) => Decision | undefined): InteractionHandler => ({ resolve: vi.fn(async (question: Question) => fn(question)) });
const callsNamed = (calls: Flow["calls"], name: string) => calls.filter(call => call.name === name);
const signal = (): AbortSignal => new AbortController().signal;

describe("authenticateSession (MCP)", () => {
  it("elicits the method-selection question and never self-selects", async () => {
    const server = flow([methodQuestion(), tokenQuestion()]);
    const handler = answering(question => {
      const properties = (question.schema?.properties ?? {}) as Record<string, unknown>;
      return "method_id" in properties ? { answer: "accept", content: { method_id: "agent" } } : { answer: "accept", content: { token: "t0ken" } };
    });
    const status = await authenticateSession(server.client, handler, ref, signal(), 5);
    expect(status).toMatchObject({ state: "ready", terminal: true, authenticated: true });
    expect(handler.resolve).toHaveBeenCalled();
    const answers = callsNamed(server.calls, "answer_question");
    expect(answers[0]!.args).toMatchObject({ session_id: "s1", request_id: "q-method", content: { method_id: "agent" } });
    expect(answers[0]!.args.message_id).toBeUndefined();
  });

  it("supports consecutive token/code input rounds", async () => {
    const second: Question = { ...tokenQuestion(), request_id: "q-code", message: "Enter the device code shown in your browser.", schema: { type: "object", properties: { code: { type: "string", minLength: 1 } }, required: ["code"], additionalProperties: false } };
    const server = flow([methodQuestion(), tokenQuestion(), second]);
    const handler = answering(question => {
      const properties = (question.schema?.properties ?? {}) as Record<string, unknown>;
      if ("method_id" in properties) return { answer: "accept", content: { method_id: "agent" } };
      if ("token" in properties) return { answer: "accept", content: { token: "tok" } };
      return { answer: "accept", content: { code: "ABCD-1234" } };
    });
    const status = await authenticateSession(server.client, handler, ref, signal(), 5);
    expect(status.terminal).toBe(true);
    expect(handler.resolve).toHaveBeenCalledTimes(3);
    expect(callsNamed(server.calls, "answer_question")).toHaveLength(3);
  });

  it("shows the complete URL and keeps polling after the confirmation", async () => {
    const url = `https://auth.example.com/login?state=${"a".repeat(600)}&scope=openid`;
    const server = flow([methodQuestion(), urlQuestion(url)]);
    const seen: Question[] = [];
    const handler = answering(question => {
      seen.push(question);
      const properties = (question.schema?.properties ?? {}) as Record<string, unknown>;
      return "method_id" in properties ? { answer: "accept", content: { method_id: "agent" } } : { answer: "accept", content: { opened: true } };
    });
    const status = await authenticateSession(server.client, handler, ref, signal(), 5);
    expect(status.terminal).toBe(true);
    expect(seen.find(question => question.request_id === "q-url")?.message).toContain(url);
    expect(callsNamed(server.calls, "answer_question")[1]!.args).toMatchObject({ request_id: "q-url", content: { opened: true } });
  });

  it("returns waiting_input with the questions and sends no answer when elicitation is unavailable", async () => {
    const server = flow([methodQuestion()]);
    const handler = answering(() => undefined);
    const status = await authenticateSession(server.client, handler, ref, signal(), 5);
    expect(status).toMatchObject({ state: "waiting_input", terminal: false });
    expect((status.questions as Question[])[0]!.request_id).toBe("q-method");
    expect(callsNamed(server.calls, "answer_question")).toHaveLength(0);
  });

  it("forwards a user decline as a real answer", async () => {
    const server = flow([methodQuestion(), tokenQuestion()]);
    const handler = answering(question => (question.request_id === "q-method" ? { answer: "reject" } : { answer: "accept", content: { token: "x" } }));
    await authenticateSession(server.client, handler, ref, signal(), 5);
    expect(callsNamed(server.calls, "answer_question")[0]!.args).toMatchObject({ request_id: "q-method", answer: "reject" });
  });

  it("forwards a standard permission question's elicited option_id", async () => {
    const permission: Question = { request_id: "q-perm", kind: "permission", title: "Allow?", message: "Allow the action?", options: [{ optionId: "allow", name: "Allow" }, { optionId: "deny", name: "Deny" }], schema: null };
    const server = flow([methodQuestion(), permission]);
    const handler = answering(question => question.request_id === "q-method"
      ? { answer: "accept", content: { method_id: "agent" } }
      : { answer: "accept", option_id: "allow" });
    const status = await authenticateSession(server.client, handler, ref, signal(), 5);
    expect(status.terminal).toBe(true);
    expect(callsNamed(server.calls, "answer_question")[1]!.args).toMatchObject({ request_id: "q-perm", answer: "accept", option_id: "allow" });
    expect(callsNamed(server.calls, "answer_question")[1]!.args.message_id).toBeUndefined();
  });

  it("revalidates before answering: a stale/superseded decision is never submitted", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let statusCalls = 0;
    const client = {
      async call(name: string, args: Record<string, unknown> = {}) {
        calls.push({ name, args });
        if (name === "authenticate") return { session_id: "s1", state: "waiting_input", terminal: false, questions: [methodQuestion()] };
        if (name === "auth_status") {
          statusCalls += 1;
          return statusCalls >= 2
            ? { session_id: "s1", state: "ready", terminal: true, questions: [], authenticated: true }
            : { session_id: "s1", state: "waiting_input", terminal: false, questions: [methodQuestion()] };
        }
        return {};
      },
    } as unknown as BridgeHttpClient;
    const handler: InteractionHandler = { resolve: () => new Promise(resolve => { setTimeout(() => resolve({ answer: "accept", content: { method_id: "agent" } }), 12); }) };
    const status = await authenticateSession(client, handler, ref, signal(), 5);
    expect(status.terminal).toBe(true);
    expect(calls.some(call => call.name === "answer_question")).toBe(false);
  });

  it("aborts a superseded/stale dialog and never answers it", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let terminal = false;
    const captured: { signal?: AbortSignal } = {};
    const client = {
      async call(name: string, args: Record<string, unknown> = {}) {
        calls.push({ name, args });
        if (name === "authenticate") return { session_id: "s1", state: "waiting_input", terminal: false, questions: [methodQuestion()] };
        if (name === "auth_status") return terminal
          ? { session_id: "s1", state: "ready", terminal: true, authenticated: true, questions: [] }
          : { session_id: "s1", state: "waiting_input", terminal: false, questions: [methodQuestion()] };
        return {};
      },
    } as unknown as BridgeHttpClient;
    const handler: InteractionHandler = { resolve: (_q, sig) => { captured.signal = sig; return new Promise(() => { /* never resolves */ }); } };
    const promise = authenticateSession(client, handler, ref, new AbortController().signal, 5);
    await vi.waitFor(() => expect(captured.signal).toBeDefined());
    terminal = true;
    const status = await promise;
    expect(status.terminal).toBe(true);
    expect(captured.signal?.aborted).toBe(true);
    expect(callsNamed(calls, "answer_question")).toHaveLength(0);
  });

  it("detaches locally on abort without answering or cancelling", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const client = {
      async call(name: string, args: Record<string, unknown> = {}) {
        calls.push({ name, args });
        if (name === "authenticate") return { session_id: "s1", state: "waiting_input", terminal: false, questions: [methodQuestion()] };
        if (name === "auth_status") return { session_id: "s1", state: "waiting_input", terminal: false, questions: [methodQuestion()] };
        return {};
      },
    } as unknown as BridgeHttpClient;
    const handler: InteractionHandler = { resolve: () => new Promise(() => { /* hangs */ }) };
    const controller = new AbortController();
    const promise = authenticateSession(client, handler, ref, controller.signal, 5);
    await vi.waitFor(() => expect(calls.some(call => call.name === "auth_status")).toBe(true));
    controller.abort();
    await expect(promise).rejects.toThrow();
    expect(calls.some(call => call.name === "answer_question" || call.name === "cancel_message")).toBe(false);
  });
});
