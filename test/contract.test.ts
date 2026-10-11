import { describe, expect, it } from "vitest";
import { METHODS, TOOL_NAMES, TOOLS, WAIT_TOOL, schemaFor } from "../src/contract.ts";

const EXPECTED = [
  "ping", "search_harness", "create_session", "close_session", "authenticate", "auth_status",
  "set_session_options", "send_message", "cancel_message", "message_status", "answer_question",
];

describe("MCP bridge contract", () => {
  it("exposes the eleven operations plus a wait helper", () => {
    expect([...METHODS].sort()).toEqual([...EXPECTED].sort());
    expect(TOOLS).toHaveLength(11);
    expect(TOOL_NAMES).toHaveLength(12);
    expect(TOOL_NAMES).toContain("wait");
    expect(TOOL_NAMES).not.toContain("live_output");
    expect(WAIT_TOOL.name).toBe("wait");
  });

  it("removed legacy names are absent", () => {
    for (const legacy of ["harness_info", "auth_info", "set_model", "message_result", "send", "live_output"]) {
      expect(METHODS).not.toContain(legacy as never);
      expect(TOOL_NAMES).not.toContain(legacy);
    }
  });

  it("authenticate takes only session_id and rejects the old method_id parameter", () => {
    const schema = schemaFor("authenticate");
    expect(schema.safeParse({ session_id: "s" }).success).toBe(true);
    expect(schema.safeParse({ session_id: "s", method_id: "agent" }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it("create_session no longer accepts an authenticate parameter", () => {
    const schema = schemaFor("create_session");
    expect(schema.safeParse({ cwd: "/repo", model_id: "m" }).success).toBe(true);
    expect(schema.safeParse({ cwd: "/repo", model_id: "m", authenticate: "agent" }).success).toBe(false);
  });

  it("send_message keeps the server semantics and drops mode/queue/steering", () => {
    const schema = schemaFor("send_message");
    expect(schema.safeParse({ session_id: "s", text: "hi" }).success).toBe(true);
    expect(schema.safeParse({ session_id: "s", text: "hi", idempotency_key: "k" }).success).toBe(true);
    for (const removed of [{ mode: "steer" }, { queue: true }, { steering: "followUp" }]) {
      expect(schema.safeParse({ session_id: "s", text: "hi", ...removed }).success).toBe(false);
    }
  });

  it("create_session rejects launch internals and validates docker options", () => {
    const schema = schemaFor("create_session");
    expect(schema.safeParse({ cwd: "/repo", model_id: "m" }).success).toBe(true);
    expect(schema.safeParse({
      cwd: "/repo", model_id: "m", runtime: "docker", docker_image: "img:1",
      mounts: [{ source: "/a", target: "/b", read_only: true }],
      ports: [{ host_port: 1000, container_port: 2000, protocol: "tcp" }],
    }).success).toBe(true);
    for (const internal of ["command", "args", "env", "session_dir", "state_dir", "ssh_command"]) {
      expect(schema.safeParse({ cwd: "/repo", model_id: "m", [internal]: "x" }).success).toBe(false);
    }
    expect(schema.safeParse({ cwd: "/repo", model_id: "m", permission_mode: "yolo" }).success).toBe(true);
    expect(schema.safeParse({ cwd: "/repo", model_id: "m", permission_mode: "root" }).success).toBe(false);
  });

  it("answer_question takes a string request_id, answer enum, option_id, and object content; message_id is optional", () => {
    const schema = schemaFor("answer_question");
    // Message-scoped question.
    expect(schema.safeParse({ session_id: "s", message_id: "m", request_id: "42" }).success).toBe(true);
    expect(schema.safeParse({ session_id: "s", message_id: "m", request_id: "42", answer: "accept", option_id: "allow_once" }).success).toBe(true);
    expect(schema.safeParse({ session_id: "s", message_id: "m", request_id: "42", answer: "accept", content: { value: "x" } }).success).toBe(true);
    // Session-scoped authentication question: message_id omitted.
    expect(schema.safeParse({ session_id: "s", request_id: "42", content: { method_id: "agent" } }).success).toBe(true);
    expect(schema.safeParse({ session_id: "s", request_id: "42" }).success).toBe(true);
    expect(schema.safeParse({ session_id: "s", message_id: "m", request_id: 42 }).success).toBe(false);
    expect(schema.safeParse({ session_id: "s", message_id: "m", request_id: "42", answer: "approve" }).success).toBe(false);
  });

  it("wait requires a session and message reference", () => {
    expect(WAIT_TOOL.inputSchema.safeParse({ session_id: "s", message_id: "m" }).success).toBe(true);
    expect(WAIT_TOOL.inputSchema.safeParse({ session_id: "s" }).success).toBe(false);
    expect(WAIT_TOOL.inputSchema.safeParse({ session_id: "s", message_id: "m", extra: 1 }).success).toBe(false);
  });
});
