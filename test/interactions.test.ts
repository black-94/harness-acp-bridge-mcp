import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { ElicitationHandler, type Question } from "../src/interactions.ts";

const signal = (): AbortSignal => new AbortController().signal;

function handler(capabilities: unknown, elicitResult: unknown) {
  const elicitInput = vi.fn(async () => elicitResult);
  const server = { server: { getClientCapabilities: () => capabilities, elicitInput } } as unknown as McpServer;
  return { handler: new ElicitationHandler(server, 1000), elicitInput };
}

const permission: Question = {
  request_id: "1", kind: "permission", title: "Run bash", message: "Allow?",
  options: [{ optionId: "allow_once", name: "Allow" }, { optionId: "deny_once", name: "Deny" }], schema: null,
};

describe("MCP elicitation handling", () => {
  it("detects form capability, including the legacy empty object, and rejects url-only", () => {
    expect(handler({ elicitation: { form: {} } }, {}).handler.supportsElicitation()).toBe(true);
    expect(handler({ elicitation: {} }, {}).handler.supportsElicitation()).toBe(true);
    expect(handler({ elicitation: { url: {} } }, {}).handler.supportsElicitation()).toBe(false);
    expect(handler({}, {}).handler.supportsElicitation()).toBe(false);
    expect(handler(undefined, {}).handler.supportsElicitation()).toBe(false);
  });

  it("does not send a form when the client only supports url elicitation", async () => {
    const { handler: instance, elicitInput } = handler({ elicitation: { url: {} } }, { action: "accept", content: { option_id: "allow_once" } });
    expect(await instance.resolve(permission, signal())).toBeUndefined();
    expect(elicitInput).not.toHaveBeenCalled();
  });

  it("maps an offered option back to its exact optionId and never approves an unoffered one", async () => {
    const ok = handler({ elicitation: { form: {} } }, { action: "accept", content: { option_id: "deny_once" } });
    expect(await ok.handler.resolve(permission, signal())).toEqual({ answer: "accept", option_id: "deny_once" });
    const bad = handler({ elicitation: { form: {} } }, { action: "accept", content: { option_id: "root" } });
    expect(await bad.handler.resolve(permission, signal())).toBeUndefined();
  });

  it.each([["decline", "reject"], ["cancel", "cancel"], ["timeout", "timeout"]])("maps %s to %s", async (action, answer) => {
    const { handler: instance } = handler({ elicitation: { form: {} } }, { action, content: undefined });
    expect(await instance.resolve(permission, signal())).toEqual({ answer });
  });

  it("accepts a representable form and validates it against the full schema", async () => {
    const schema = { type: "object", properties: { value: { type: "string", minLength: 3 } }, required: ["value"] };
    const good = handler({ elicitation: { form: {} } }, { action: "accept", content: { value: "blue" } });
    expect(await good.handler.resolve({ ...permission, kind: "information", options: [], schema }, signal()))
      .toEqual({ answer: "accept", content: { value: "blue" } });
    const bad = handler({ elicitation: { form: {} } }, { action: "accept", content: { value: "ab" } });
    expect(await bad.handler.resolve({ ...permission, kind: "information", options: [], schema }, signal())).toBeUndefined();
  });

  it("leaves a question pending for a schema it cannot represent losslessly", async () => {
    const { handler: instance, elicitInput } = handler({ elicitation: { form: {} } }, { action: "accept", content: { code: "abc" } });
    const schema = { type: "object", properties: { code: { type: "string", pattern: "^[0-9]+$" } }, required: ["code"] };
    expect(await instance.resolve({ ...permission, kind: "information", options: [], schema }, signal())).toBeUndefined();
    expect(elicitInput).not.toHaveBeenCalled();
  });

  it("returns undefined when the elicitation response fails SDK validation", async () => {
    const elicitInput = vi.fn(async () => { throw new McpError(ErrorCode.InvalidParams, "bad"); });
    const server = { server: { getClientCapabilities: () => ({ elicitation: { form: {} } }), elicitInput } } as unknown as McpServer;
    expect(await new ElicitationHandler(server, 1000).resolve(permission, signal())).toBeUndefined();
  });

  it("elicits a boolean confirm question (URL/device-code) and rejects a value the harness did not offer", async () => {
    const schema = { type: "object", properties: { opened: { type: "boolean", enum: [true] } }, required: ["opened"], additionalProperties: false };
    const question = { ...permission, kind: "information" as const, options: [], schema };
    const ok = handler({ elicitation: { form: {} } }, { action: "accept", content: { opened: true } });
    expect(await ok.handler.resolve(question, signal())).toEqual({ answer: "accept", content: { opened: true } });
    expect(ok.elicitInput).toHaveBeenCalled();
    // A value outside the harness enum is refused (kept pending for a manual answer).
    const bad = handler({ elicitation: { form: {} } }, { action: "accept", content: { opened: false } });
    expect(await bad.handler.resolve(question, signal())).toBeUndefined();
  });

  it("elicits a method-selection question (string enum) and returns the user's chosen id", async () => {
    const schema = { type: "object", properties: { method_id: { type: "string", enum: ["agent", "enterprise"] } }, required: ["method_id"], additionalProperties: false };
    const { handler: instance } = handler({ elicitation: { form: {} } }, { action: "accept", content: { method_id: "enterprise" } });
    expect(await instance.resolve({ ...permission, kind: "information", options: [], schema }, signal())).toEqual({ answer: "accept", content: { method_id: "enterprise" } });
  });

  it("enforces additionalProperties:false (ajv does not silently ignore it)", async () => {
    const schema = { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false };
    const { handler: instance } = handler({ elicitation: { form: {} } }, { action: "accept", content: { value: "x", extra: "y" } });
    expect(await instance.resolve({ ...permission, kind: "information", options: [], schema }, signal())).toBeUndefined();
  });

  it("re-checks the signal after queueing so a superseded dialog never elicits", async () => {
    let releaseFirst!: () => void;
    const elicitInput = vi.fn(async () => { await new Promise<void>(resolve => { releaseFirst = resolve; }); return { action: "accept", content: { option_id: "allow_once" } }; });
    const server = { server: { getClientCapabilities: () => ({ elicitation: { form: {} } }), elicitInput } } as unknown as McpServer;
    const instance = new ElicitationHandler(server, 1000);
    const first = instance.resolve(permission, signal());
    await vi.waitFor(() => expect(elicitInput).toHaveBeenCalledTimes(1));
    const controller = new AbortController();
    const second = instance.resolve(permission, controller.signal);
    controller.abort();
    releaseFirst();
    await first;
    await expect(second).rejects.toThrow();
    // The aborted, still-queued dialog never opened.
    expect(elicitInput).toHaveBeenCalledTimes(1);
  });
});
