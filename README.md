# @black942026/harness-acp-bridge-mcp

Stdio [MCP](https://modelcontextprotocol.io) proxy for the
[harness-acp-bridge server](https://github.com/black-94/harness-acp-bridge-server).

It exposes the server's twelve HTTP operations as MCP tools. It owns no harness, state, or
scheduling: most tools are a single `POST /api/<name>`, while `send_message`/`wait` submit (or
resume) once and then poll `message_status` until the message is terminal. If no compatible
server is listening on the configured **loopback** address, the proxy starts the installed
server package as a managed background service and reuses it. Harness processes, scheduling,
persistence, SSH/Docker launch, and authentication all remain the server's responsibility.

```text
MCP client --stdio JSON-RPC--> this proxy --HTTP POST /api/<name>--> bridge server
```

`send_message` keeps the server's asynchronous contract but **waits for the terminal result in
the same tool call**, exactly like the Pi client. A second tool, `wait`, resumes waiting for a
known `session_id`/`message_id` without resubmitting.

> **Tool-call timeout:** the proxy sends **no progress notifications** (so no output body leaks
> through them). A `send_message`/`wait` is therefore one long-running tool call; configure the
> MCP client's per-call timeout to cover the full turn, and `HARNESS_ACP_BRIDGE_TIMEOUT_MS` to
> cover a single HTTP request.

## Install

```bash
npx -y @black942026/harness-acp-bridge-mcp
```

Register it as a stdio MCP server; it has no CLI arguments or admin flags.

## Configuration

Environment variables win over the optional JSON file (`config.example.json`, selected with
`HARNESS_ACP_BRIDGE_MCP_CONFIG`). The only accepted JSON keys are `baseUrl`, `timeoutMs`,
`autoStart`, `serverEntry`, `configPath`, and `startupTimeoutMs`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HARNESS_ACP_BRIDGE_URL` | `http://127.0.0.1:8787` | Base URL of the server. `http`/`https` only; no credentials, query, or fragment. |
| `HARNESS_ACP_BRIDGE_TIMEOUT_MS` | `120000` | Per-request HTTP timeout. |
| `HARNESS_ACP_BRIDGE_AUTOSTART` | `true` | Start a local server when the configured one is unreachable. |
| `HARNESS_ACP_BRIDGE_SERVER_ENTRY` | installed dependency | Server module or path to load when starting a local server. A path is resolved against the proxy's startup cwd; a `file:` URL is used as-is. It must export `HarnessHttpServer`/`loadConfig` (the server package index), **not** a CLI such as `dist/main.js`. |
| `HARNESS_ACP_BRIDGE_CONFIG` | — | Server YAML config path passed to the started server (also honored as a client setting). |
| `HARNESS_ACP_BRIDGE_STARTUP_TIMEOUT_MS` | `30000` | How long to wait for a started server to answer `ping`. |
| `HARNESS_ACP_BRIDGE_MCP_CONFIG` | — | Optional JSON settings file. |
| `HARNESS_ACP_BRIDGE_CLIENT_DIR` | `~/.harness-acp-bridge-client` | Client-owned directory for the start lock, server log, and pid registry. |

The proxy never accepts a command or argv pass-through, so a caller cannot make it launch
anything but the configured server module through the managed path.

## Local server lifecycle

1. `ping` the configured `baseUrl`. A server answering `ping` with `protocol_version: 2` is
   reused as-is.
2. If the address answered but is **not** a compatible bridge server (an error envelope, a
   different protocol version, or a non-JSON listener), the proxy reports `incompatible_server`
   and starts nothing — a foreign service is never treated as "absent".
3. If nothing is listening and `autoStart` is on, the proxy starts the server **only for a
   loopback address**. A non-loopback `baseUrl` is never spawned, locally or over SSH.
4. Starts are serialized with a per-address lock in the client directory, then re-checked, so
   two clients racing to start the same instance converge on one server (the server's own
   `state_dir` lock and port binding are the final backstop).
5. The started server is detached with no inherited stdio. It survives the proxy and is **never
   killed by it**, so it cannot tear down another client's sessions. It is recorded (pid + log
   path) in `<client dir>/servers.json` for management; redacted diagnostics come from its log.
6. `shutdown`/`reload` release only the client's own transport. They never close server
   sessions or stop a reused instance.

## Tools

Twelve operations plus `wait`:

| Tool | Behavior |
| --- | --- |
| `ping` | Liveness, protocol version, PID, uptime, live session count, config fingerprint. |
| `search_harness` | Configured harnesses, models, thinking levels, permission modes. Starts nothing. |
| `create_session` | Create a session-owned harness (`cwd`, `model_id`, plus optional launch fields). |
| `close_session` | Stop the harness and close the session (idempotent). |
| `authenticate` | Run the harness's own login and open the session. |
| `auth_status` | Probe harness authentication (unsupported probes fail with original details). |
| `set_session_options` | Change `model_id` / `thinking_level` / `permission_mode` on an idle session. |
| `send_message` | Submit a prompt and synchronously wait for the terminal result in this call. |
| `cancel_message` | Cancel the active message and wait for it to settle. |
| `message_status` | State, terminal flag, pending `questions`, unsupported events, errors, and result. |
| `live_output` | Paged human-readable events with `cursor` / `limit` / `wait_ms`. |
| `answer_question` | Answer a reverse request by `request_id` (`option_id` or object `content`). |
| `wait` | Resume waiting for a known `session_id`/`message_id`; never resubmits. |

### Reverse requests

While `send_message`/`wait` runs, a reverse permission or information request is answered with
an MCP **elicitation** when the connected client advertised the capability: offered permission
options are mapped back to their exact `optionId`, and nothing is approved by default (a
decline maps to reject, a cancel to cancel, and an unoffered selection is refused). When the
client cannot elicit, the tool returns `waiting_input` with the original `questions` so the
model can call `answer_question` and then `wait`. Aborting the request cancels the remote
message, matching the Pi client.

`live_output` is the only way to read incremental output; no preview is ever mixed into a
result. `send_message`/`wait` return only the terminal status (whose `result` is the server's
final answer). The proxy sends no progress notifications, so no output body leaks through them.

Each success returns the server's `data` object as JSON text. A failure returns an MCP tool
error (`isError: true`) whose text is the envelope
`{ "ok": false, "error": { "code", "message", "detail" } }`, preserving the server error code.

## Develop

```bash
npm ci
npm run check                 # clean + build + typecheck + tests
npm pack --dry-run
```

`npm run check` starts the real installed server package and its fake ACP harness (no paid
model, Docker, or SSH) and drives it through real stdio MCP clients with and without elicitation
capability, including autostart, reuse, answer+wait, cancel, and paging. Point
`ACP_BRIDGE_SERVER_DIR` at a server checkout for the fake harness fixture (defaults to
`../server`).

## License

MIT
