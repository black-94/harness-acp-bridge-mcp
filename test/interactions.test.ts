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
});
