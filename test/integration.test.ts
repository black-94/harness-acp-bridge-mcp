/**
 * End-to-end MCP proxy tests: a real stdio client, the proxy, a real harness-acp-bridge HTTP
 * server it starts on demand (the installed server dependency), and the server's fake ACP
 * harness. Skips when the proxy or the server fixture is not built. No paid model/Docker/SSH.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bridgeConfig, fakeHarness, freePort, killRegistryServers, mcpMain, newContractServerEntry, registry, serverAvailable } from "./support.ts";

interface CallResult { content?: Array<{ type?: string; text?: string }>; isError?: boolean }
function payload(result: CallResult): any {
  return JSON.parse(result.content?.find(part => part.type === "text")?.text ?? "null");
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await client.callTool({ name, arguments: args }) as CallResult;
  if (result.isError) throw new Error(`tool ${name} failed: ${JSON.stringify(payload(result))}`);
  return payload(result);
}

describe.runIf(serverAvailable())("MCP proxy with autostart, elicitation and sync wait", () => {
  let dir: string;
  let clientDir: string;
  let baseUrl: string;
  let capable: Client;
  let capableTransport: StdioClientTransport;
  let session: string;
  const elicitations: string[] = [];

  const proxyEnv = (): Record<string, string> => ({
    ...getDefaultEnvironment(),
    HARNESS_ACP_BRIDGE_URL: baseUrl,
    // Start the in-repo server build (not the installed dependency).
    HARNESS_ACP_BRIDGE_SERVER_ENTRY: newContractServerEntry()!,
    HARNESS_ACP_BRIDGE_CONFIG: join(dir, "config.yaml"),
    HARNESS_ACP_BRIDGE_CLIENT_DIR: clientDir,
    HARNESS_ACP_BRIDGE_TIMEOUT_MS: "15000",
    HARNESS_ACP_BRIDGE_STARTUP_TIMEOUT_MS: "20000",
  });

  const spawnProxy = async (
    capabilities: Record<string, unknown> | undefined,
    onElicit?: (request: unknown, extra: unknown) => unknown,
  ): Promise<{ client: Client; transport: StdioClientTransport }> => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [mcpMain], env: proxyEnv(), stderr: "pipe" });
    const client = new Client({ name: "e2e", version: "0.0.0" }, capabilities ? { capabilities: capabilities as never } : undefined);
    if (onElicit) client.setRequestHandler(ElicitRequestSchema, async (request, extra) => onElicit(request, extra) as never);
    await client.connect(transport);
    return { client, transport };
  };

  const connectProxy = async (elicitation: boolean): Promise<{ client: Client; transport: StdioClientTransport }> => {
    if (!elicitation) return spawnProxy(undefined);
    return spawnProxy({ elicitation: {} }, request => {
      // The SDK hands the response-validation wrapper the full request envelope; accept either shape.
      const params = ((request as { params?: unknown }).params ?? request) as { message?: string; requestedSchema?: { properties?: Record<string, any> } };
      const properties = (params.requestedSchema?.properties ?? {}) as Record<string, any>;
      elicitations.push(String(params.message ?? ""));
      if (properties.option_id) return { action: "accept", content: { option_id: "allow_once" } };
      const content: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(properties)) {
        content[key] = value.type === "boolean" ? true : value.type === "number" || value.type === "integer" ? 1 : Array.isArray(value.enum) ? value.enum[0] : "blue";
      }
      return { action: "accept", content };
    });
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "mcp-e2e-"));
    clientDir = join(dir, "client");
    const port = await freePort();
    writeFileSync(join(dir, "config.yaml"), bridgeConfig(port, join(dir, "sessions")));
    // Harness commands come from the explicit command/args/env or the execution target's PATH.
    // Install PATH wrappers around the fake harness so a command-less create_session still resolves.
    const bin = join(dir, "bin");
    mkdirSync(bin);
    const quote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
    for (const [command, flags] of [["codebuddy", ""], ["codex-acp", "--fake-agent=codex --auth-methods"]]) {
      writeFileSync(join(bin, command), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fakeHarness)} ${flags} "$@"\n`, { mode: 0o755 });
    }
    vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
    baseUrl = `http://127.0.0.1:${port}`;
    ({ client: capable, transport: capableTransport } = await connectProxy(true));
  }, 40000);

  afterAll(async () => {
    vi.unstubAllEnvs();
    await capable?.close().catch(() => {});
    killRegistryServers(clientDir);
    // The detached server keeps writing its log briefly after SIGTERM; retry the recursive remove.
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("lists ten operations plus two template tools and wait", async () => {
    const listed = await capable.listTools();
    expect(listed.tools.map(tool => tool.name).sort()).toEqual([
      "answer_question", "auth_status", "authenticate", "cancel_message", "close_session", "create_session",
      "create_template", "message_status", "ping", "search_template",
      "send_message", "set_session_options", "wait",
    ]);
  });

  it("autostarts the local server when none is running, then pings it", async () => {
    expect(registry(clientDir)).toEqual({});
    expect(await call(capable, "ping")).toMatchObject({ status: "ok", protocol_version: 4 });
    expect(Object.keys(registry(clientDir))).toEqual([baseUrl]);
    expect((await capable.listTools()).tools.map(tool => tool.name)).not.toContain("search_harness");
  });

  it("creates a session and synchronously completes a message", async () => {
    session = (await call(capable, "create_session", { cwd: dir, model_id: "fake-model" })).session_id;
    const status = await call(capable, "send_message", { session_id: session, text: "hello 中文😀" });
    expect(status.terminal).toBe(true);
    expect(status.result.text).toBe("echo:hello 中文😀");
  });

  it("registers and searches a template without starting a harness", async () => {
    const sessionDirs = (): string[] => readdirSync(join(dir, "sessions"), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    const before = sessionDirs();
    const guidance = { model: "fake-model", thinking: "low", before_start: "检查启动依赖。",
      after_start: "检查会话状态。", special_instructions: "遵循用户指示 😀" };
    const created = await call(capable, "create_template", {
      template: { name: "mcp-local", harness: "codebuddy", description: "local direct", cwd: dir, ...guidance },
    });
    // The server applies defaults and returns the full template; no session was created.
    expect(created.template).toMatchObject({
      name: "mcp-local", harness: "codebuddy", runtime: "direct", target: "local",
      cwd: dir, permission_mode: "auto", args: [], env: {}, mounts: [], ports: [], network_mode: "none", proxy_port: null, ...guidance,
    });
    expect(created.session_id).toBeUndefined();
    // Registering a template creates no session directory (templates.json is not a session).
    expect(sessionDirs()).toEqual(before);

    // Exact name, case-insensitive query, and harness all find it, with the full content.
    const byName = await call(capable, "search_template", { name: "mcp-local" });
    expect(byName.templates).toHaveLength(1);
    expect(byName.templates[0]).toMatchObject({ name: "mcp-local", cwd: dir, permission_mode: "auto", command: null, docker_image: null, ...guidance });
    expect((await call(capable, "search_template", { query: "MCP-LOCAL" })).templates.map((t: { name: string }) => t.name)).toContain("mcp-local");
    expect((await call(capable, "search_template", { query: "direct" })).templates.map((t: { name: string }) => t.name)).toContain("mcp-local");
    expect((await call(capable, "search_template", { harness: "codebuddy" })).templates.map((t: { name: string }) => t.name)).toContain("mcp-local");
    expect((await call(capable, "search_template", { harness: "codex" })).templates.map((t: { name: string }) => t.name)).not.toContain("mcp-local");
    expect((await call(capable, "search_template", { name: "nope" })).templates).toHaveLength(0);
    // Searching also starts nothing.
    expect(sessionDirs()).toEqual(before);
  });

  it("rejects a duplicate template name instead of overwriting it", async () => {
    const duplicate = await capable.callTool({ name: "create_template", arguments: {
      template: { name: "mcp-local", harness: "codebuddy", description: "changed", cwd: "/elsewhere" },
    } });
    expect(duplicate.isError).toBe(true);
    expect(payload(duplicate)).toMatchObject({ ok: false, error: { code: "template_exists" } });
    // The original template is untouched.
    const found = (await call(capable, "search_template", { name: "mcp-local" })).templates[0];
    expect(found).toMatchObject({ description: "local direct", cwd: dir });
  });

  it("expands a searched template into explicit create_session parameters (no template/meta) and honors a cwd override", async () => {
    // A distinct existing absolute directory, so an override cannot be confused with inheritance.
    const overrideDir = join(dir, "override-cwd");
    mkdirSync(overrideDir, { recursive: true });

    // LLM-style expansion: read the template, then hand-pick only the fields create_session accepts,
    // dropping name/description and every field that does not apply.
    const template = (await call(capable, "search_template", { name: "mcp-local" })).templates[0];
    const expand = (overrides: Record<string, unknown>): Record<string, unknown> => ({
      harness: template.harness, runtime: template.runtime, target: template.target,
      permission_mode: template.permission_mode, command: template.command, args: template.args, env: template.env,
      cwd: template.cwd,
      ...(template.model !== null ? { model_id: template.model } : {}),
      ...(template.thinking !== null ? { thinking_level: template.thinking } : {}), ...overrides,
    });
    for (const forbidden of ["template", "name", "description", "model", "thinking", "before_start", "after_start", "special_instructions"]) expect(expand({})).not.toHaveProperty(forbidden);

    // The template's cwd is used, and the snapshot reports no selected-template identity.
    const inherited = await call(capable, "create_session", expand({}));
    expect(inherited.options).toMatchObject({ model_id: "fake-model", thinking_level: "low" });
    expect(inherited.cwd).toBe(dir);
    expect(inherited.template).toBeUndefined();
    expect((await call(capable, "send_message", { session_id: inherited.session_id, text: "via-expansion" })).result.text).toBe("echo:via-expansion");
    await call(capable, "close_session", { session_id: inherited.session_id });

    // An explicit cwd override is reported and used.
    const overridden = await call(capable, "create_session", expand({ cwd: overrideDir, model_id: "fake-model-2", thinking_level: "high" }));
    expect(overridden.options).toMatchObject({ model_id: "fake-model-2", thinking_level: "high" });
    expect(overridden.cwd).toBe(overrideDir);
    expect(overridden.cwd).not.toBe(dir);
    expect((await call(capable, "send_message", { session_id: overridden.session_id, text: "override" })).result.text).toBe("echo:override");
    await call(capable, "close_session", { session_id: overridden.session_id });
  });

  it("runs a fake harness with the command/args/env expanded from a template", async () => {
    const promptFile = join(dir, "expanded-prompts.txt");
    await call(capable, "create_template", {
      template: { name: "mcp-rich", harness: "codebuddy", command: process.execPath, args: [fakeHarness],
        env: { FAKE_HARNESS_PROMPT_FILE: promptFile }, cwd: dir },
    });
    const found = (await call(capable, "search_template", { name: "mcp-rich" })).templates[0];
    expect(found).toMatchObject({ command: process.execPath, args: [fakeHarness], env: { FAKE_HARNESS_PROMPT_FILE: promptFile } });
    // A template's command/args/env are used as *information* and passed to create_session directly.
    const session = (await call(capable, "create_session", {
      harness: found.harness, runtime: found.runtime, target: found.target, command: found.command,
      args: found.args, env: found.env, cwd: found.cwd, model_id: "fake-model",
    })).session_id;
    const status = await call(capable, "send_message", { session_id: session, text: "expanded-env" });
    expect(status.result.text).toBe("echo:expanded-env");
    // The env reached the harness (it recorded the prompt), proving command+args+env were applied.
    expect(readFileSync(promptFile, "utf8")).toContain("expanded-env");
    await call(capable, "close_session", { session_id: session });
  });

  it("round-trips a searched Docker template under a new name (null host_ip)", async () => {
    await call(capable, "create_template", {
      template: {
        name: "mcp-docker-rt", harness: "codebuddy", runtime: "docker", docker_image: "example:latest", cwd: "/workspace",
        network_mode: "proxy", proxy_port: 12345, env: { KEEP: "keep", HTTPS_PROXY: "stale" },
        ports: [{ host_port: 8080, container_port: 8080, protocol: "tcp", host_ip: null }],
        mounts: [{ source: "/host/repo", target: "/workspace", read_only: false }],
      },
    });
    const searched = (await call(capable, "search_template", { name: "mcp-docker-rt" })).templates[0];
    // The server stores host_ip as null; the found template must be re-registrable unchanged.
    expect(searched.ports[0]).toMatchObject({ host_port: 8080, container_port: 8080, protocol: "tcp", host_ip: null });
    expect(searched).not.toHaveProperty("host_network");
    expect(searched).toMatchObject({ network_mode: "proxy", proxy_port: 12345, env: {
      KEEP: "keep", http_proxy: "http://host.docker.internal:12345", https_proxy: "http://host.docker.internal:12345",
      no_proxy: "localhost,127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,.local,.internal",
    } });
    expect(searched.env).not.toHaveProperty("HTTPS_PROXY");
    const renamed = await call(capable, "create_template", { template: { ...searched, name: "mcp-docker-rt-2" } });
    expect(renamed.template).toMatchObject({ name: "mcp-docker-rt-2", docker_image: "example:latest", runtime: "docker", env: searched.env, proxy_port: 12345 });
    expect(renamed.template.ports[0]).toMatchObject({ host_port: 8080, host_ip: null });
  });

  it("rejects a template reference, template metadata, and launch internals on create_session", async () => {
    for (const extra of [
      { template: "mcp-local" }, { name: "mcp-local" }, { description: "x" },
      { session_dir: "/tmp/x" }, { state_dir: "/tmp/x" }, { ssh_command: "sh" },
    ]) {
      const rejected = await capable.callTool({ name: "create_session", arguments: { cwd: dir, model_id: "fake-model", ...extra } });
      expect(rejected.isError).toBe(true);
    }
  });

  it("surfaces an invalid template registration", async () => {
    const invalid = await capable.callTool({ name: "create_template", arguments: { template: { name: "bad-docker", harness: "codebuddy", docker_image: "img:1" } } });
    expect(invalid.isError).toBe(true);
    expect(payload(invalid)).toMatchObject({ ok: false, error: { code: "invalid_template" } });
  });

  it("rejects a create_session without cwd and a create_template with launch internals", async () => {
    // cwd is required by the strict schema (not by the server) when no template can supply it.
    const noCwd = await capable.callTool({ name: "create_session", arguments: { model_id: "fake-model" } });
    expect(noCwd.isError).toBe(true);
    // Template internals the server owns are rejected by the create_template schema.
    const templateInternal = await capable.callTool({ name: "create_template", arguments: { template: { name: "x", harness: "codebuddy", docker_id: "a".repeat(64) } } });
    expect(templateInternal.isError).toBe(true);
  });

  it("auto-answers a permission request through elicitation without approving by default", async () => {
    const status = await call(capable, "send_message", { session_id: session, text: "permission" });
    expect(status.terminal).toBe(true);
    expect(status.result.text).toContain("[allowed:allow_once]");
    expect(elicitations.some(message => /Allow this action/.test(message))).toBe(true);
  });

  it("auto-answers a form elicitation with the schema's fields", async () => {
    const status = await call(capable, "send_message", { session_id: session, text: "elicit-form" });
    expect(status.terminal).toBe(true);
    expect(status.result.text).toContain('[elicited:{"value":"blue"}]');
  });

  it("flags a real failed message as a tool error while preserving its status", async () => {
    const result = await capable.callTool({ name: "send_message", arguments: { session_id: session, text: "bad-json" } }) as CallResult;
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ state: "failed", terminal: true, error: { code: "invalid_json" } });
  });

  it("returns waiting_input for a schema it cannot represent and answers it explicitly", async () => {
    const pending = await call(capable, "send_message", { session_id: session, text: "info" });
    expect(pending.terminal).toBe(false);
    expect(pending.state).toBe("waiting_input");
    await call(capable, "answer_question", { session_id: session, message_id: pending.message_id, request_id: pending.questions[0].request_id, content: { value: "Ada" } });
    const done = await call(capable, "wait", { session_id: session, message_id: pending.message_id });
    expect(done.terminal).toBe(true);
    expect(done.result.text).toContain('[info:{"value":"Ada"}]');
  });

  it("does not send a form when the client advertises only url elicitation", async () => {
    const { client } = await spawnProxy({ elicitation: { url: {} } });
    try {
      const echoSession = (await call(client, "create_session", { cwd: dir, model_id: "fake-model" })).session_id;
      const pending = await call(client, "send_message", { session_id: echoSession, text: "permission" });
      expect(pending.terminal).toBe(false);
      expect(pending.state).toBe("waiting_input");
      await call(client, "cancel_message", { session_id: echoSession, message_id: pending.message_id });
      await call(client, "close_session", { session_id: echoSession });
    } finally { await client.close().catch(() => {}); }
  });

  it("returns a terminal result promptly even while an elicitation is hanging", async () => {
    const { client } = await spawnProxy({ elicitation: {} }, () => new Promise(() => { /* never resolves */ }));
    try {
      const echoSession = (await call(client, "create_session", { cwd: dir, model_id: "fake-model" })).session_id;
      const started = Date.now();
      const result = await client.callTool({ name: "send_message", arguments: { session_id: echoSession, text: "permission" } }) as CallResult;
      expect(result.isError).toBe(true);
      const status = payload(result);
      expect(status.terminal).toBe(true);
      expect(status.state).toBe("failed");
      // The proxy abandons the pending elicitation at the input timeout instead of blocking.
      expect(Date.now() - started).toBeLessThan(7000);
      await call(client, "close_session", { session_id: echoSession });
    } finally { await client.close().catch(() => {}); }
  });

  it("returns the terminal result from a normal message (no live_output endpoint)", async () => {
    const status = await call(capable, "send_message", { session_id: session, text: "fragments😀" });
    expect(status.terminal).toBe(true);
    expect(status.result.text).toBe("echo:fragments😀");
  });

  it("drives a real unauthenticated session through the auth flow to ready", async () => {
    const messages: string[] = [];
    const { client } = await spawnProxy({ elicitation: {} }, (request: unknown) => {
      const params = ((request as { params?: unknown }).params ?? request) as { message?: string; requestedSchema?: { properties?: Record<string, any> } };
      const properties = (params.requestedSchema?.properties ?? {}) as Record<string, any>;
      messages.push(String(params.message ?? ""));
      if (properties.method_id) return { action: "accept", content: { method_id: "device" } };
      if (properties.opened) return { action: "accept", content: { opened: true } };
      const content: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(properties)) content[key] = value.type === "boolean" ? true : "blue";
      return { action: "accept", content };
    });
    try {
      // A login-gated harness: create_session surfaces the structured authentication_required error.
      const created = await client.callTool({ name: "create_session", arguments: { cwd: dir, model_id: "fake-model", harness: "codex" } }) as CallResult;
      expect(created.isError).toBe(true);
      const failure = payload(created);
      expect(failure.error.code).toBe("authentication_required");
      const sessionId = failure.error.detail.session_id as string;
      expect(typeof sessionId).toBe("string");

      const ready = await call(client, "authenticate", { session_id: sessionId });
      expect(ready).toMatchObject({ state: "ready", terminal: true, authenticated: true });
      // The unsupported candidate, the full verification URL, and the device code were all shown.
      expect(messages.some(message => message.includes("Not supported in harness_acp_bridge"))).toBe(true);
      expect(messages.some(message => message.includes("https://example.test/device"))).toBe(true);
      expect(messages.some(message => message.includes("ABCD-1234"))).toBe(true);

      const status = await call(client, "auth_status", { session_id: sessionId });
      expect(status.authenticated).toBe(true);
      await call(client, "close_session", { session_id: sessionId });
    } finally { await client.close().catch(() => {}); }
  });

  it("closes the session", async () => {
    expect((await call(capable, "close_session", { session_id: session })).session_id).toBe(session);
  });

  it("reuses one server; without elicitation returns waiting_input, then answer+wait and cancel", async () => {
    const recordBefore = registry(clientDir);
    const { client } = await connectProxy(false);
    try {
      const echoSession = (await call(client, "create_session", { cwd: dir, model_id: "fake-model" })).session_id;

      // No elicitation: send_message returns waiting_input with the original question.
      const pending = await call(client, "send_message", { session_id: echoSession, text: "permission" });
      expect(pending.terminal).toBe(false);
      expect(pending.state).toBe("waiting_input");
      const question = pending.questions[0];
      expect(typeof question.request_id).toBe("string");
      await call(client, "answer_question", { session_id: echoSession, message_id: pending.message_id, request_id: question.request_id, option_id: "allow_once" });
      const done = await call(client, "wait", { session_id: echoSession, message_id: pending.message_id });
      expect(done.terminal).toBe(true);
      expect(done.result.text).toContain("[allowed:allow_once]");

      // Cancellation: cancel a message that is waiting for input.
      const second = await call(client, "send_message", { session_id: echoSession, text: "permission" });
      expect(second.state).toBe("waiting_input");
      const cancelled = await call(client, "cancel_message", { session_id: echoSession, message_id: second.message_id });
      expect(cancelled.terminal).toBe(true);
      expect(cancelled.state).toBe("cancelled");

      expect(registry(clientDir)).toEqual(recordBefore);
      await call(client, "close_session", { session_id: echoSession });
    } finally {
      await client.close().catch(() => {});
    }
  });
});
