/**
 * The bridge operations as MCP tools.
 *
 * These mirror the server's `POST /api/<name>` contract exactly (parameter names, types, and
 * semantics). Legacy names (`harness_info`, `auth_info`, `set_model`, `message_result`) and the
 * old `mode`/`queue`/`steering` parameters and `offset` protocol are intentionally absent.
 *
 * A tool's `name` is model-facing; `method` is the server HTTP method it calls. They differ only
 * for `create_template`, which is a client alias for the server's `register_template` operation
 * (there is no `POST /api/create_template`). `delete_template` is deliberately not exposed.
 */
import { z } from "zod";

/** Server HTTP methods this proxy calls. `register_template` backs the `create_template` tool. */
export const METHODS = [
  "ping",
  "search_harness",
  "create_session",
  "close_session",
  "authenticate",
  "auth_status",
  "set_session_options",
  "send_message",
  "cancel_message",
  "message_status",
  "answer_question",
  "register_template",
  "search_template",
] as const;
export type BridgeMethod = (typeof METHODS)[number];

const permissionMode = z.enum(["read", "edit", "auto", "yolo"]);
/** Every caller string that can reach an exec string must be NUL-free (the server enforces this too). */
const noNul = (schema: z.ZodString): z.ZodString => schema.refine(value => !value.includes("\0"), "must not contain NUL");
/**
 * An environment map. zod's record parse silently DROPS an own `"__proto__"` key (it cannot
 * represent it), while the server accepts every `[A-Za-z_][A-Za-z0-9_]*` name — so rather than lose
 * a value the MCP client rejects such input explicitly (safe rejection, never a silent strip).
 */
const envField = z
  .preprocess(
    (raw) =>
      raw !== null && typeof raw === "object" && !Array.isArray(raw) && Object.prototype.hasOwnProperty.call(raw, "__proto__")
        ? "env must not contain a __proto__ key"
        : raw,
    z.record(
      z.string().refine(key => !key.includes("\0"), "must not contain NUL"),
      z.string().refine(value => !value.includes("\0"), "must not contain NUL"),
    ),
  )
  .optional();
const dockerMount = z
  .object({ source: noNul(z.string().min(1)), target: noNul(z.string().min(1)), read_only: z.boolean().optional() })
  .strict();
const dockerPort = z
  .object({
    host_port: z.number().int().min(1).max(65535),
    container_port: z.number().int().min(1).max(65535),
    protocol: z.enum(["tcp", "udp"]).optional(),
    // Nullable to match the server contract: a template searched with `host_ip: null` can be
    // expanded into create_session without rewriting the field.
    host_ip: noNul(z.string().min(1)).nullable().optional(),
  })
  .strict();
// A template's port has the same nullable `host_ip` shape as create_session's.
const templatePort = z
  .object({
    host_port: z.number().int().min(1).max(65535),
    container_port: z.number().int().min(1).max(65535),
    protocol: z.enum(["tcp", "udp"]).optional(),
    host_ip: noNul(z.string()).nullable().optional(),
  })
  .strict();

/**
 * A launch template as accepted by `register_template` (`create_template`). Only the fields the
 * server can actually register are accepted; unknown keys are rejected. `name` and `harness` are
 * required; every other field is optional (the server applies defaults and rejects
 * Docker fields on a `direct` template, a local `remote_host`, etc.). Persistence, argv
 * validation, and duplicate-name rejection (`template_exists`, never an overwrite) are the
 * server's responsibility.
 */
const launchTemplate = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    description: z.string().nullable().optional(),
    harness: z.enum(["codebuddy", "codex", "agy"]),
    runtime: z.enum(["direct", "docker"]).optional(),
    target: z.enum(["local", "remote"]).optional(),
    remote_host: noNul(z.string()).nullable().optional(),
    permission_mode: permissionMode.optional(),
    command: noNul(z.string()).nullable().optional(),
    args: z.array(noNul(z.string())).optional(),
    env: envField,
    cwd: noNul(z.string()).nullable().optional(),
    docker_image: noNul(z.string()).nullable().optional(),
    container_policy: z.enum(["remove", "keep"]).optional(),
    login_dirs: z.array(dockerMount).optional(),
    mounts: z.array(dockerMount).optional(),
    ports: z.array(templatePort).optional(),
    host_network: z.boolean().optional(),
  })
  .strict();

/**
 * `create_session` fields shared by both variants. `cwd` and `model_id` are always required: a
 * session is a direct call, never a template reference. The launch executable/argv/environment
 * (`command`/`args`/`env`) and Docker-only `login_dirs` are direct session parameters.
 */
const createSessionBase = {
  model_id: noNul(z.string().min(1)),
  harness: noNul(z.string().min(1)).optional(),
  command: noNul(z.string()).nullable().optional(),
  args: z.array(noNul(z.string())).optional(),
  env: envField,
  thinking_level: noNul(z.string().min(1)).optional(),
  permission_mode: permissionMode.optional(),
  resume_session_id: noNul(z.string().min(1)).optional(),
  session_id: noNul(z.string().min(1)).optional(),
  target: z.enum(["local", "remote"]).optional(),
  remote_host: noNul(z.string().min(1)).optional(),
  runtime: z.enum(["direct", "docker"]).optional(),
  // Nullable so a template's neutral defaults (`container_policy: null`, `docker_image: null`) can
  // be expanded into create_session without rewriting the field.
  container_policy: z.enum(["remove", "keep"]).nullable().optional(),
  docker_id: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  docker_image: noNul(z.string().min(1)).nullable().optional(),
  login_dirs: z.array(dockerMount).optional(),
  mounts: z.array(dockerMount).optional(),
  ports: z.array(dockerPort).optional(),
  host_network: z.boolean().optional(),
} as const;

/** True when any *effective* (non-neutral) Docker option is present. */
function hasEffectiveDocker(data: Record<string, unknown>): boolean {
  return (
    typeof data.docker_image === "string" ||
    data.docker_id !== undefined ||
    (data.container_policy !== undefined && data.container_policy !== null) ||
    (Array.isArray(data.mounts) && data.mounts.length > 0) ||
    (Array.isArray(data.login_dirs) && data.login_dirs.length > 0) ||
    (Array.isArray(data.ports) && data.ports.length > 0) ||
    data.host_network === true
  );
}

const schemas: Record<BridgeMethod, z.ZodType> = {
  ping: z.object({}).strict(),
  search_harness: z.object({ harness: z.string().min(1).optional() }).strict(),
  // A single strict object (the MCP SDK exports only object schemas to the model, so a root union
  // would arrive empty). `cwd` and `model_id` are required, there is no `template` parameter, and
  // the object-level refinements enforce the key cross-field rules (all also enforced server-side):
  // published ports exclude host networking, a reused container fixes its own Docker fields, and a
  // direct runtime rejects *effective* Docker options while still accepting neutral defaults.
  create_session: z
    .object({ ...createSessionBase, cwd: noNul(z.string().min(1)) })
    .strict()
    .refine(data => !(data.host_network === true && (data.ports?.length ?? 0) > 0), {
      message: "host_network cannot be combined with published ports",
      path: ["ports"],
    })
    .refine(data => data.docker_id === undefined || !(
      typeof data.docker_image === "string" ||
      (data.mounts?.length ?? 0) > 0 ||
      (data.login_dirs?.length ?? 0) > 0 ||
      (data.ports?.length ?? 0) > 0 ||
      data.host_network === true
    ), {
      message: "a reused container (docker_id) already fixes its image, mounts, ports, and network",
      path: ["docker_id"],
    })
    .refine(data => data.runtime === "docker" || !hasEffectiveDocker(data), {
      message: "container options require runtime=docker",
      path: ["runtime"],
    }),
  register_template: z.object({ template: launchTemplate }).strict(),
  search_template: z
    .object({ name: z.string().min(1).optional(), query: z.string().min(1).optional(), harness: z.string().min(1).optional() })
    .strict(),
  close_session: z.object({ session_id: z.string().min(1) }).strict(),
  authenticate: z.object({ session_id: z.string().min(1) }).strict(),
  auth_status: z.object({ session_id: z.string().min(1) }).strict(),
  set_session_options: z
    .object({
      session_id: z.string().min(1),
      model_id: z.string().min(1).optional(),
      thinking_level: z.string().min(1).optional(),
      permission_mode: permissionMode.optional(),
    })
    .strict(),
  send_message: z
    .object({
      session_id: z.string().min(1),
      text: z.string().min(1),
      idempotency_key: z.string().min(1).optional(),
    })
    .strict(),
  cancel_message: z.object({ session_id: z.string().min(1), message_id: z.string().min(1) }).strict(),
  message_status: z.object({ session_id: z.string().min(1), message_id: z.string().min(1) }).strict(),
  answer_question: z
    .object({
      session_id: z.string().min(1),
      message_id: z.string().min(1).optional(),
      request_id: z.string().min(1),
      answer: z.enum(["accept", "reject", "timeout", "cancel"]).optional(),
      option_id: z.string().min(1).optional(),
      content: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
};

export interface McpTool {
  /** Model-facing tool name. */
  name: string;
  /** Server HTTP method this tool calls: `POST /api/<method>`. */
  method: BridgeMethod;
  title: string;
  description: string;
  inputSchema: z.ZodType;
  /** MCP tool annotations. `external` reaches an external harness; template tools never do. */
  annotations: { openWorldHint: boolean; readOnlyHint?: boolean; destructiveHint?: boolean };
}

export type BridgeTool = McpTool;

const readOnly = { openWorldHint: false, readOnlyHint: true } as const;
const external = { openWorldHint: true } as const;
// Template registration is a private-server write that starts nothing; it never reaches a harness.
const serverWrite = { openWorldHint: false, readOnlyHint: false, destructiveHint: false } as const;

const toolDefs: Array<Omit<BridgeTool, "method"> & { method?: BridgeMethod }> = [
  {
    name: "ping",
    title: "Ping bridge",
    description:
      "Check that the harness-acp-bridge server is reachable. Returns protocol version, PID, uptime, live session count, and the configuration fingerprint. Never starts a harness.",
    inputSchema: schemas.ping,
    annotations: readOnly,
  },
  {
    name: "search_harness",
    title: "Search harnesses",
    description:
      "List configured harnesses with their models, declared thinking levels, and permission modes, from configuration only. Starts no harness and performs no discovery probes.",
    inputSchema: schemas.search_harness,
    annotations: readOnly,
  },
  {
    name: "search_template",
    title: "Search launch templates",
    description:
      "Find registered launch templates by exact name, free-text query (case-insensitive substring of name/harness/description), and/or harness. Returns each matching template in full, including its command/args/env/cwd/Docker defaults. Templates are INFORMATION ONLY: create_session never accepts a template name, so read the returned object and expand the allowed fields yourself when creating a session. Starts no harness.",
    inputSchema: schemas.search_template,
    annotations: readOnly,
  },
  {
    name: "create_template",
    method: "register_template",
    title: "Create launch template",
    description:
      "Durably register a launch template (client alias for the server's register_template; it does not create a session and starts no harness). Supply {template: {...}} with name and harness plus any of description/runtime/target/remote_host/permission_mode/command/args/env/cwd/docker_image/container_policy/login_dirs/mounts/ports/host_network. A duplicate name is rejected (template_exists) and never overwrites the existing template. Collect the values with the user first (see the acp-create-template skill) and confirm the summary.",
    inputSchema: schemas.register_template,
    annotations: serverWrite,
  },
  {
    name: "create_session",
    title: "Create session",
    description:
      "Create a session-owned harness process from explicit parameters. cwd and model_id are REQUIRED; there is no template parameter. Launch parameters: harness; command (absolute executable path or single executable name; empty/omitted uses the harness's built-in command) and args/env; permission_mode/thinking_level; target/remote_host; runtime and the Docker fields (docker_image for a new container, or docker_id to reuse; container_policy, login_dirs, mounts, ports, host_network). login_dirs and mounts are bind mounts used only for runtime=docker; login_dirs persist the harness's own credentials (not bridge credentials). To start from a template: search_template (exact name, else query/harness), read the returned object in full, DROP name/description and any field that does not apply (e.g. all Docker fields for a direct session), collect a model_id and any missing cwd from the user, apply the user's overrides, then pass only the allowed create_session fields — never pass template/name/description. Omit a field the template stores as null when null is not a valid session value (a local template's remote_host: null — pass remote_host only for a remote session; a null cwd — supply the user's cwd). When you override runtime or target, re-check that the remaining fields are still valid (e.g. Docker fields require docker; a remote target needs remote_host). Returns the session snapshot (no template identity). If authentication is required, the structured error carries session_id and a next_action telling you to call authenticate.",
    inputSchema: schemas.create_session,
    annotations: external,
  },
  {
    name: "close_session",
    title: "Close session",
    description: "Stop the harness and close the session. Repeated close is safe. Returns the session id and state.",
    inputSchema: schemas.close_session,
    annotations: external,
  },
  {
    name: "authenticate",
    title: "Authenticate session",
    description:
      "Start or resume the child harness authentication flow for session_id. The proxy elicits every server-provided question, submits answers without message_id, and polls until ready/failed/cancelled. Without elicitation it returns waiting_input for manual answer_question followed by authenticate. Aborting only detaches the local wait.",
    inputSchema: schemas.authenticate,
    annotations: external,
  },
  {
    name: "auth_status",
    title: "Authentication status",
    description:
      "Return the current authentication workflow shape when one exists; otherwise probe harness authentication. Unknown authentication is never guessed as logged out.",
    inputSchema: schemas.auth_status,
    annotations: external,
  },
  {
    name: "set_session_options",
    title: "Set session options",
    description:
      "Change model_id, thinking_level, and/or permission_mode of an idle session. At least one option is required. Applies only session settings.",
    inputSchema: schemas.set_session_options,
    annotations: external,
  },
  {
    name: "send_message",
    title: "Send message",
    description:
      "Submit a prompt to a session and synchronously wait for its final result in this same tool call. The server accepts it asynchronously; while it runs, a reverse permission/information request is answered through MCP elicitation when the client supports it (never auto-approved). When the client cannot elicit, the call returns waiting_input with the original question so the model can answer_question and then wait. Aborting cancels the remote message. Supports idempotency_key.",
    inputSchema: schemas.send_message,
    annotations: external,
  },
  {
    name: "cancel_message",
    title: "Cancel message",
    description:
      "Request cancellation of the active message and wait for the original prompt to settle. An unconfirmed cancellation closes the session. Returns the terminal message status.",
    inputSchema: schemas.cancel_message,
    annotations: external,
  },
  {
    name: "message_status",
    title: "Message status",
    description:
      "Return a message's state, terminal flag, pending questions, unsupported events, errors, and terminal result (text, reasoning, tool_calls, stop_reason, raw_result). Works after close or server restart.",
    inputSchema: schemas.message_status,
    annotations: external,
  },
  {
    name: "answer_question",
    title: "Answer question",
    description:
      "Answer a pending reverse request by session_id/request_id. message_id is required for message questions and omitted for session authentication. answer defaults to accept. Permissions require an offered option_id; information and elicitation require object content.",
    inputSchema: schemas.answer_question,
    annotations: external,
  },
];

/** Tool name → HTTP method. Defaults to the tool name; `create_template` maps to `register_template`. */
export const TOOLS: BridgeTool[] = toolDefs.map(def => ({ ...def, method: def.method ?? (def.name as BridgeMethod) }));

/** The input schema for a model-facing tool name (not an HTTP method). */
export function schemaFor(name: string): z.ZodType {
  const tool = TOOLS.find(entry => entry.name === name) ?? (name === WAIT_TOOL.name ? WAIT_TOOL : undefined);
  if (!tool) throw new Error(`unknown tool: ${name}`);
  return tool.inputSchema;
}

/** Extra tool: resume waiting for a known message without submitting it again. */
export const WAIT_TOOL: McpTool = {
  name: "wait",
  method: "message_status",
  title: "Wait for message",
  description:
    "Wait for a previously submitted message by session_id/message_id without resubmitting it. Handles reverse requests through MCP elicitation when supported; otherwise returns waiting_input with the original question so the model can answer_question and wait again. Aborting only stops local waiting and leaves the remote message running; another wait can resume it.",
  inputSchema: z.object({ session_id: z.string().min(1), message_id: z.string().min(1) }).strict(),
  annotations: external,
};

export const TOOL_NAMES: string[] = [...TOOLS.map(tool => tool.name), WAIT_TOOL.name];
