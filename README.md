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
5. The started server runs as a child of a **detached logging supervisor**. The supervisor holds
   the server's real stdout/stderr fds as pipes and appends only redacted bytes to the log, so it
   survives the proxy and is **never killed by it** — it cannot tear down another client's
   sessions. `<client dir>/servers.json` records the actual server pid, the supervisor pid, and
   the log path. Ownership is proven, not guessed: the proxy spawns the supervisor with a fresh
   nonce and claims the server only when the answering ping pid equals the supervisor's recorded
   `server_pid` and the private proof file carries that nonce. A peer that won the race is reused;
   a foreign listener is never treated as absent and never killed.
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

## Privacy

The proxy is a thin client: the real HTTP response is what it returns. It only sanitizes the
**copies it persists**, and only common credential shapes.

- The detached bootstrap is a **logging supervisor**: it launches the actual server with stdout
  and stderr as **pipes** (never the log file) and redacts both streams — independently, with
  bounded cross-chunk state — before appending to `server-<addr>.log`. Because the real fds are
  pipes, every output path is covered: `console`, `stream.write`, **`fs.writeSync(1/2)`**,
  `fs.writev`, native modules, dynamic-import and runtime diagnostics. A JS-level `write` patch
  cannot see fd-level writes; the pipe boundary can.
- Redaction lives entirely in the detached supervisor, never in the client, so it keeps working
  after the client exits while the server stays alive. At EOF both held tails are flushed
  (masked) before the log fd is closed, and existing log bytes are never rewritten (append only).
- A redactor or disk error never falls back to raw bytes: a redactor exception drops the chunk,
  and a disk write failure stops the owned server and exits non-zero rather than retrying forever
  or letting the server block on a full pipe.
- `logTail`/registry read-time masking is defense in depth only, never the security boundary.
- `servers.json` is sanitized before its atomic write; the top-level map keys are base URLs
  (already credential-free) and stay intact so registry and ownership lookups keep working. The
  log file is mode 0600 in a mode-0700 client directory, and the launcher proof file is mode 0600.
- Rules are the **canonical server files copied verbatim**: `src/redact-core.ts` and
  `src/redact.ts` are byte-identical to `server/src/redact-core.ts`
  (sha256 `b07ef16e39483b008c0f03e3da05dc194c87fa93080b53accf34317586d2a6c8`) and
  `server/src/redact.ts` (sha256 `fa8e4bfedee21dd2c8014544cb8a9daacf8378c83fba874a8ad1714cf7fa450f`).
  The build emits `dist/redact-core.js` + `dist/redact.js`, so nothing is hand-ported. To re-sync:
  copy the two files over `src/` and rebuild.
- A cross-package parity harness (`scripts/tests/redaction-parity.mjs` at the repo root) loads the
  server, MCP, and Pi modules and asserts byte-exact output for both the non-streaming and
  streaming APIs across a representative battery (report: `/tmp/redaction-parity-final.log`).
- Unknown/unrecognized text — including counters like `max_tokens` and ordinary CJK/emoji text —
  is preserved verbatim. This is not a guarantee that every unknown secret is removed.

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
