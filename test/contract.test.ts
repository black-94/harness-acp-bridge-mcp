import { describe, expect, it } from "vitest";
import { METHODS, TOOL_NAMES, TOOLS, WAIT_TOOL, schemaFor } from "../src/contract.ts";

const EXPECTED_HTTP = [
  "ping", "create_session", "close_session", "authenticate", "auth_status",
  "set_session_options", "send_message", "cancel_message", "message_status", "answer_question",
  "register_template", "search_template",
];

const EXPECTED_TOOLS = [
  "ping", "search_template", "create_template", "create_session", "close_session",
  "authenticate", "auth_status", "set_session_options", "send_message", "cancel_message",
  "message_status", "answer_question",
];

const tool = (name: string) => TOOLS.find(entry => entry.name === name)!;

describe("MCP bridge contract", () => {
  it("exposes ten operations plus two template tools and a wait helper", () => {
    expect([...METHODS].sort()).toEqual([...EXPECTED_HTTP].sort());
    expect(TOOLS).toHaveLength(12);
    expect(TOOLS.map(entry => entry.name).sort()).toEqual([...EXPECTED_TOOLS].sort());
    expect(TOOL_NAMES).toHaveLength(13);
    expect(TOOL_NAMES).toContain("wait");
    expect(TOOL_NAMES).not.toContain("live_output");
    expect(WAIT_TOOL.name).toBe("wait");
  });

  it("distinguishes tool names from HTTP methods and routes create_template to register_template", () => {
    expect(tool("create_template").method).toBe("register_template");
    expect(tool("search_template").method).toBe("search_template");
    // Every other tool posts to its own name; there is no POST /api/create_template.
    for (const entry of TOOLS) {
      if (entry.name === "create_template") continue;
      expect(entry.method).toBe(entry.name);
    }
    expect(METHODS).not.toContain("create_template" as never);
    // delete_template is deliberately not exposed.
    expect(TOOL_NAMES).not.toContain("delete_template");
    expect(METHODS).not.toContain("delete_template" as never);
  });

  it("annotates template tools as non-harness (read-only search, non-destructive write)", () => {
    expect(tool("search_template").annotations).toEqual({ openWorldHint: false, readOnlyHint: true });
    expect(tool("create_template").annotations).toEqual({ openWorldHint: false, readOnlyHint: false, destructiveHint: false });
  });

  it("removed legacy names are absent", () => {
    for (const legacy of ["search_harness", "harness_info", "auth_info", "set_model", "message_result", "send", "live_output"]) {
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

  it("create_session requires cwd and model_id and rejects a template reference", () => {
    const schema = schemaFor("create_session");
    expect(schema.safeParse({ cwd: "/repo", model_id: "m" }).success).toBe(true);
    // Both cwd and model_id are always required, and a template name is an unknown key.
    expect(schema.safeParse({ model_id: "m" }).success).toBe(false);
    expect(schema.safeParse({ cwd: "/repo" }).success).toBe(false);
    expect(schema.safeParse({ cwd: "/repo", model_id: "m", template: "t" }).success).toBe(false);
    expect(schema.safeParse({ cwd: "/repo", model_id: "m", name: "t" }).success).toBe(false);
    expect(schema.safeParse({ cwd: "/repo", model_id: "m", description: "x" }).success).toBe(false);
    for (const field of ["model", "thinking", "network_mode", "proxy_port", "before_start", "after_start", "special_instructions"]) {
      expect(schema.safeParse({ cwd: "/repo", model_id: "m", [field]: "x" }).success).toBe(false);
    }
  });

  it("create_session accepts the launch executable/argv/env and login_dirs, and validates docker options", () => {
    const schema = schemaFor("create_session");
    expect(schema.safeParse({ cwd: "/repo", model_id: "m" }).success).toBe(true);
    expect(schema.safeParse({ cwd: "/repo", model_id: "m", command: "/usr/local/bin/codebuddy", args: ["--verbose"],
      env: { HOME: "/home/me" } }).success).toBe(true);
    // `command` may be empty/null/omitted (built-in executable).
    expect(schema.safeParse({ cwd: "/repo", model_id: "m", command: null }).success).toBe(true);
    expect(schema.safeParse({ cwd: "/repo", model_id: "m", command: "" }).success).toBe(true);
    expect(schema.safeParse({
      cwd: "/workspace", model_id: "m", runtime: "docker", docker_image: "img:1",
      login_dirs: [{ source: "/a", target: "/creds", read_only: true }],
      mounts: [{ source: "/b", target: "/repo", read_only: false }],
      ports: [{ host_port: 1000, container_port: 2000, protocol: "tcp" }],
    }).success).toBe(true);
    // Session_dir/state_dir/ssh_command remain launch internals the server owns.
    for (const internal of ["session_dir", "state_dir", "ssh_command"]) {
      expect(schema.safeParse({ cwd: "/repo", model_id: "m", [internal]: "x" }).success).toBe(false);
    }
    expect(schema.safeParse({ cwd: "/repo", model_id: "m", permission_mode: "yolo" }).success).toBe(true);
    expect(schema.safeParse({ cwd: "/repo", model_id: "m", permission_mode: "root" }).success).toBe(false);
  });

  it("create_session rejects NUL in every launch string and never silently strips a __proto__ env key", () => {
    const schema = schemaFor("create_session");
    const base = { cwd: "/w", model_id: "m" };
    expect(schema.safeParse({ ...base, cwd: "/w\0bad" }).success).toBe(false);
    expect(schema.safeParse({ ...base, model_id: "m\0odel" }).success).toBe(false);
    expect(schema.safeParse({ ...base, command: "a\0b" }).success).toBe(false);
    expect(schema.safeParse({ ...base, args: ["a\0b"] }).success).toBe(false);
    expect(schema.safeParse({ ...base, env: { OK: "a\0b" } }).success).toBe(false);
    expect(schema.safeParse({ ...base, runtime: "docker", docker_image: "i\0mg" }).success).toBe(false);
    expect(schema.safeParse({ ...base, runtime: "docker", docker_image: "i", mounts: [{ source: "/a\0b", target: "/b" }] }).success).toBe(false);
    expect(schema.safeParse({ ...base, runtime: "docker", docker_image: "i", login_dirs: [{ source: "/a", target: "/b\0c" }] }).success).toBe(false);
    // zod's record parse would drop an own "__proto__" key; the client rejects it explicitly instead.
    expect(schema.safeParse({ ...base, env: JSON.parse('{"__proto__":"ok"}') }).success).toBe(false);
    expect(schema.safeParse({ ...base, env: JSON.parse('{"constructor":"c","toString":"t","NORMAL":"n"}') }).success).toBe(true);
  });

  it("create_session enforces the docker cross-field combinations", () => {    const schema = schemaFor("create_session");
    // host_network cannot be combined with published ports.
    expect(schema.safeParse({ cwd: "/w", model_id: "m", runtime: "docker", docker_image: "img",
      host_network: true, ports: [{ host_port: 1, container_port: 2 }] }).success).toBe(false);
    // A reused container already fixes its image/mounts/ports/network.
    const id = "a".repeat(64);
    expect(schema.safeParse({ cwd: "/w", model_id: "m", runtime: "docker", docker_id: id, docker_image: "img" }).success).toBe(false);
    expect(schema.safeParse({ cwd: "/w", model_id: "m", runtime: "docker", docker_id: id, login_dirs: [{ source: "/a", target: "/b" }] }).success).toBe(false);
    expect(schema.safeParse({ cwd: "/w", model_id: "m", runtime: "docker", docker_id: id, host_network: true }).success).toBe(false);
    expect(schema.safeParse({ cwd: "/w", model_id: "m", runtime: "docker", docker_id: id }).success).toBe(true);
    // Effective Docker options require runtime=docker, but neutral defaults are accepted.
    expect(schema.safeParse({ cwd: "/w", model_id: "m", docker_image: "img" }).success).toBe(false);
    expect(schema.safeParse({ cwd: "/w", model_id: "m", runtime: "direct", docker_image: null, container_policy: null,
      login_dirs: [], mounts: [], ports: [], host_network: false }).success).toBe(true);
  });

  it("search_template accepts only name/query/harness", () => {
    const schema = schemaFor("search_template");
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ name: "t" }).success).toBe(true);
    expect(schema.safeParse({ query: "docker" }).success).toBe(true);
    expect(schema.safeParse({ harness: "codebuddy" }).success).toBe(true);
    expect(schema.safeParse({ name: "t", query: "x", harness: "codebuddy" }).success).toBe(true);
    expect(schema.safeParse({ detail: true }).success).toBe(false);
    expect(schema.safeParse({ name: "" }).success).toBe(false);
  });

  it("create_template requires name/harness and accepts exactly the server's registrable fields", () => {
    const schema = schemaFor("create_template");
    expect(schema.safeParse({ template: { name: "t", harness: "codebuddy" } }).success).toBe(true);
    expect(schema.safeParse({ template: { name: "t" } }).success).toBe(false);
    expect(schema.safeParse({ template: { harness: "codebuddy" } }).success).toBe(false);
    expect(schema.safeParse({ template: { name: "bad name", harness: "codebuddy" } }).success).toBe(false);
    expect(schema.safeParse({ name: "t", harness: "codebuddy" }).success).toBe(false); // must be nested
    // The full field set the server can register.
    expect(schema.safeParse({
      template: {
        name: "codebuddy-docker", description: "docker", harness: "codebuddy", runtime: "docker",
        target: "remote", remote_host: "user@host", permission_mode: "edit",
        command: "codebuddy", args: ["--flag"], env: { HOME: "/home/user" }, cwd: "/workspace",
        docker_image: "img:1", container_policy: "keep",
        login_dirs: [{ source: "/a", target: "/b", read_only: true }],
        mounts: [{ source: "/c", target: "/d" }],
        ports: [{ host_port: 1, container_port: 2, protocol: "udp", host_ip: "127.0.0.1" }],
        network_mode: "none",
      },
    }).success).toBe(true);
    // Nullable fields accept null; enums are validated.
    expect(schema.safeParse({ template: { name: "t", harness: "codex", cwd: null, command: null, description: null } }).success).toBe(true);
    // A template's port host_ip is nullable (the server stores null), so a searched template can be
    // re-registered unchanged; create_session accepts the same nullable shape so a template can be
    // expanded into session parameters without rewriting ports.
    expect(schema.safeParse({ template: { name: "t", harness: "codebuddy", ports: [{ host_port: 1, container_port: 2, host_ip: null }] } }).success).toBe(true);
    expect(schema.safeParse({ template: { name: "t", harness: "codebuddy", ports: [{ host_port: 1, container_port: 2 }] } }).success).toBe(true);
    expect(schemaFor("create_session").safeParse({ cwd: "/repo", model_id: "m", runtime: "docker", docker_image: "img:1", ports: [{ host_port: 1, container_port: 2, host_ip: null }] }).success).toBe(true);
    expect(schema.safeParse({ template: { name: "t", harness: "nope" } }).success).toBe(false);
    expect(schema.safeParse({ template: { name: "t", harness: "codebuddy", runtime: "vm" } }).success).toBe(false);
    expect(schema.safeParse({ template: { name: "t", harness: "codebuddy", ports: [{ host_port: 0, container_port: 1 }] } }).success).toBe(false);
    // Unknown template fields are rejected, including launch internals the server owns.
    for (const extra of ["host_network", "docker_id", "session_dir", "ssh_host", "container_record_id"]) {
      expect(schema.safeParse({ template: { name: "t", harness: "codebuddy", [extra]: "x" } }).success).toBe(false);
    }
  });

  it("accepts none/host/proxy with one port, rejects legacy/conflicting modes and validates session proxy conflicts", () => {
    const schema = schemaFor("create_template"); const base = { name: "network", harness: "codex", runtime: "docker", docker_image: "image" };
    for (const network_mode of ["none", "host"]) expect(schema.safeParse({ template: { ...base, network_mode } }).success).toBe(true);
    expect(schema.safeParse({ template: { ...base, network_mode: "proxy", proxy_port: 12345 } }).success).toBe(true);
    for (const extra of [{ network_mode: "invalid" }, { host_network: false }, { network_mode: "proxy" },
      { network_mode: "proxy", proxy_port: null }, { network_mode: "host", proxy_port: 12345 },
      { network_mode: "none", env: { http_proxy: "http://proxy:1" } }, { network_mode: "host", ports: [{ host_port: 1, container_port: 2 }] },
      { runtime: "direct", network_mode: "proxy", proxy_port: 12345 }]) {
      expect(schema.safeParse({ template: { ...base, ...extra } }).success).toBe(false);
    }
    for (const proxy_port of [0, 65536, 1.5, "12345"]) expect(schema.safeParse({ template: { ...base, network_mode: "proxy", proxy_port } }).success).toBe(false);
    const session = schemaFor("create_session");
    for (const key of ["http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) {
      expect(session.safeParse({ cwd: "/w", model_id: "m", runtime: "docker", docker_image: "i", host_network: true, env: { [key]: "http://proxy:1" } }).success).toBe(false);
    }
    expect(session.safeParse({ cwd: "/w", model_id: "m", runtime: "docker", docker_image: "i", host_network: true, env: { http_proxy: "", no_proxy: "localhost" } }).success).toBe(true);
    expect(tool("create_template").description).toContain("proxy_port");
    expect(tool("create_session").description).toContain("network_mode and proxy_port are template-only");
  });

  it("preserves model/thinking defaults and natural-language LLM guidance", () => {
    const schema = schemaFor("create_template"); const base = { name: "guided", harness: "codebuddy" };
    const fields = { model: "custom-model", thinking: "custom-effort", before_start: "启动前检查目录。\n确认依赖。",
      after_start: "启动后检查状态。", special_instructions: "遵循用户指示 😀" };
    expect(schema.parse({ template: { ...base, ...fields } })).toEqual({ template: { ...base, ...fields } });
    for (const field of Object.keys(fields)) {
      expect(schema.safeParse({ template: { ...base, [field]: null } }).success).toBe(true);
      for (const value of [123, [], "bad\0text"]) expect(schema.safeParse({ template: { ...base, [field]: value } }).success).toBe(false);
    }
    for (const field of ["model", "thinking"]) {
      for (const value of ["", " \n "]) expect(schema.safeParse({ template: { ...base, [field]: value } }).success).toBe(false);
    }
    for (const name of ["search_template", "create_session"]) {
      for (const field of ["before_start", "after_start", "special_instructions"]) expect(tool(name).description).toContain(field);
    }
    expect(tool("create_session").description).toContain("model to model_id");
    expect(tool("create_session").description).toContain("thinking to thinking_level");
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
