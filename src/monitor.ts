/**
 * Synchronous message waiting for the MCP proxy.
 *
 * `message_status` is authoritative. A reverse request is resolved through the interaction
 * handler (MCP elicitation) **while polling continues**: if the remote turn becomes terminal or
 * a different question appears, the pending elicitation is aborted (never reported as a user
 * cancel, never cancelling an already-ended message) and the call returns promptly. A question
 * the handler cannot resolve returns the current status — including the original `questions` —
 * so the model can `answer_question` and then `wait`.
 */
import { setTimeout as delay } from "node:timers/promises";
import { isRecord } from "./config.js";
import type { Decision, InteractionHandler, Question } from "./interactions.js";
import type { BridgeHttpClient } from "./http.js";

export interface MessageRef { session_id: string; message_id: string }
export interface WaitOptions { pollIntervalMs: number; cancelOnAbort?: boolean }

export function firstQuestion(status: Record<string, unknown>): Question | undefined {
  const questions = Array.isArray(status.questions) ? status.questions : [];
  return questions.filter(isRecord).find(question => typeof question.request_id === "string") as Question | undefined;
}

type QuestionOutcome =
  | { kind: "terminal"; status: Record<string, unknown> }
  | { kind: "waiting_input" }
  | { kind: "changed" };

/**
 * Resolve one question with a dedicated abort controller while serial status polling runs.
 * Polling detects a terminal turn or a superseded request and aborts the elicitation so a stale
 * dialog cannot block completion or answer a request the server no longer waits on.
 */
async function handleQuestion(
  client: BridgeHttpClient,
  handler: InteractionHandler,
  ref: MessageRef,
  question: Question,
  signal: AbortSignal,
  pollIntervalMs: number,
): Promise<QuestionOutcome> {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  let done = false;
  let decision: Decision | undefined;
  let failure: unknown;
  const resolving = handler.resolve(question, controller.signal).then(
    value => { decision = value; done = true; },
    error => { failure = error; done = true; },
  );
  try {
    while (!done) {
      await delay(pollIntervalMs, undefined, { signal });
      const current = await client.call("message_status", { ...ref }, signal);
      if (current.terminal === true) { controller.abort(); return { kind: "terminal", status: current }; }
      const still = firstQuestion(current);
      if (!still || still.request_id !== question.request_id) { controller.abort(); return { kind: "changed" }; }
    }
    await resolving.catch(() => { /* handled below */ });
    if (signal.aborted) throw new Error("request aborted");
    if (failure !== undefined) {
      if (controller.signal.aborted) return { kind: "waiting_input" }; // aborted by us, not a real error
      throw failure;
    }
    if (decision === undefined) return { kind: "waiting_input" };
    // Revalidate against the server immediately before answering a possibly stale request.
    const current = await client.call("message_status", { ...ref }, signal);
    if (current.terminal === true) return { kind: "terminal", status: current };
    const still = firstQuestion(current);
    if (!still || still.request_id !== question.request_id) return { kind: "changed" };
    await client.call("answer_question", { ...ref, request_id: question.request_id, ...decision }, signal);
    return { kind: "changed" };
  } finally {
    signal.removeEventListener("abort", onAbort);
    controller.abort();
  }
}

export async function waitForMessage(
  client: BridgeHttpClient,
  handler: InteractionHandler,
  ref: MessageRef,
  signal: AbortSignal,
  options: WaitOptions,
): Promise<Record<string, unknown>> {
  const answered = new Set<string>();
  try {
    for (;;) {
      if (signal.aborted) throw new Error("request aborted");
      const status = await client.call("message_status", { ...ref }, signal);
      if (status.terminal === true) return status;
      const question = firstQuestion(status);
      if (question && !answered.has(question.request_id)) {
        const outcome = await handleQuestion(client, handler, ref, question, signal, options.pollIntervalMs);
        if (outcome.kind === "terminal") return outcome.status;
        if (outcome.kind === "waiting_input") return status;
        answered.add(question.request_id);
        continue;
      }
      await delay(options.pollIntervalMs, undefined, { signal });
    }
  } catch (error) {
    // send_message keeps its original policy; the wait tool only stops local waiting.
    if (signal.aborted && options.cancelOnAbort !== false) await client.call("cancel_message", { ...ref }).catch(() => {});
    throw error;
  }
}
