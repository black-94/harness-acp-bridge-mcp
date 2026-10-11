/**
 * The eleven bridge operations as MCP tools.
 *
 * These mirror the server's `POST /api/<name>` contract exactly (parameter names, types, and
 * semantics). Legacy names (`harness_info`, `auth_info`, `set_model`, `message_result`) and the
 * old `mode`/`queue`/`steering` parameters and `offset` protocol are intentionally absent.
 */
import { z } from "zod";

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
] as const;
export type BridgeMethod = (typeof METHODS)[number];

const permissionMode = z.enum(["read", "edit", "auto", "yolo"]);
const dockerMount = z
  .object({ source: z.string().min(1), target: z.string().min(1), read_only: z.boolean().optional() })
  .strict();
const dockerPort = z
  .object({
    host_port: z.number().int().min(1).max(65535),
    container_port: z.number().int().min(1).max(65535),
    protocol: z.enum(["tcp", "udp"]).optional(),
    host_ip: z.string().min(1).optional(),
  })
  .strict();

const schemas: Record<BridgeMethod, z.ZodType> = {
  ping: z.object({}).strict(),
  search_harness: z.object({ harness: z.string().min(1).optional() }).strict(),
  create_session: z
    .object({
      cwd: z.string().min(1),
      model_id: z.string().min(1),
      harness: z.string().min(1).optional(),
      thinking_level: z.string().min(1).optional(),
      permission_mode: permissionMode.optional(),
      resume_session_id: z.string().min(1).optional(),
      session_id: z.string().min(1).optional(),
      target: z.enum(["local", "remote"]).optional(),
      remote_host: z.string().min(1).optional(),
      runtime: z.enum(["direct", "docker"]).optional(),
      container_policy: z.enum(["remove", "keep"]).optional(),
      docker_id: z.string().regex(/^[0-9a-f]{64}$/).optional(),
      docker_image: z.string().min(1).optional(),
      mounts: z.array(dockerMount).optional(),
      ports: z.array(dockerPort).optional(),
      host_network: z.boolean().optional(),
    })
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
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodType;
  /** MCP tool annotations; every bridge operation reaches an external harness process. */
  annotations: { openWorldHint: boolean; readOnlyHint?: boolean; destructiveHint?: boolean };
}

export type BridgeTool = McpTool & { name: BridgeMethod };

const readOnly = { openWorldHint: false, readOnlyHint: true } as const;
const external = { openWorldHint: true } as const;

export const TOOLS: BridgeTool[] = [
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
    name: "create_session",
    title: "Create session",
    description:
      "Create a session-owned harness process. cwd and model_id are required. Optional harness, thinking_level, permission_mode, and launch fields (target/runtime/docker/resume). Returns the session snapshot including session_id. If authentication is required, the structured error retains session_id and tells the model to call authenticate.",
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

export function schemaFor(method: BridgeMethod): z.ZodType {
  return schemas[method];
}

/** Extra tool: resume waiting for a known message without submitting it again. */
export const WAIT_TOOL: McpTool = {
  name: "wait",
  title: "Wait for message",
  description:
    "Wait for a previously submitted message by session_id/message_id without resubmitting it. Handles reverse requests through MCP elicitation when supported; otherwise returns waiting_input with the original question so the model can answer_question and wait again. Aborting only stops local waiting and leaves the remote message running; another wait can resume it.",
  inputSchema: z.object({ session_id: z.string().min(1), message_id: z.string().min(1) }).strict(),
  annotations: external,
};

export const TOOL_NAMES: string[] = [...TOOLS.map(tool => tool.name), WAIT_TOOL.name];
