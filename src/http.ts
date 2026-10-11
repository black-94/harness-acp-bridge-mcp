/**
 * Minimal HTTP client for the harness-acp-bridge server.
 *
 * Every operation is `POST /api/<name>` with the parameter object as the JSON body. Success is
 * `{ ok: true, data }`; failure is `{ ok: false, error: { code, message, detail } }`. Success
 * is never guessed: only `ok === true` with an object `data` is treated as a value.
 */
import { isRecord } from "./config.js";

export class BridgeError extends Error {
  override name = "BridgeError";
  constructor(readonly code: string, message: string, readonly detail?: unknown) { super(message); }
}

export function errorInfo(error: unknown): { code: string; message: string; detail?: unknown } {
  if (error instanceof BridgeError) {
    return { code: error.code, message: error.message, ...(error.detail !== undefined ? { detail: error.detail } : {}) };
  }
  return { code: "internal_error", message: error instanceof Error ? error.message : String(error) };
}

export interface BridgeHttpOptions {
  baseUrl: string;
  timeoutMs: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export class BridgeHttpClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: BridgeHttpOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async call(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const timedOut = { value: false };
    const timeoutController = new AbortController();
    const timer = setTimeout(() => { timedOut.value = true; timeoutController.abort(); }, this.timeoutMs);
    timer.unref?.();
    const signals = [timeoutController.signal, ...(signal ? [signal] : [])];
    const composite = signals.length > 1 ? AbortSignal.any(signals) : signals[0]!;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(params ?? {}),
        signal: composite,
      });
    } catch (error) {
      if (signal?.aborted) throw new BridgeError("request_aborted", "the HTTP request was cancelled");
      if (timedOut.value) throw new BridgeError("request_timeout", `${method} did not answer within ${this.timeoutMs}ms`);
      throw new BridgeError("network_error", `could not reach harness-acp-bridge at ${this.baseUrl}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }

    let text: string;
    try { text = await response.text(); }
    catch (error) {
      if (signal?.aborted) throw new BridgeError("request_aborted", "the HTTP response was cancelled");
      throw new BridgeError("invalid_response", `${method} response could not be read: ${error instanceof Error ? error.message : String(error)}`);
    }

    let body: unknown;
    try { body = JSON.parse(text); }
    catch { throw new BridgeError("invalid_response", `${method} returned a non-JSON response (HTTP ${response.status})`); }
    if (!isRecord(body)) throw new BridgeError("invalid_response", `${method} returned a non-object envelope (HTTP ${response.status})`);

    if (body.ok === true) {
      if (!isRecord(body.data)) throw new BridgeError("invalid_response", `${method} succeeded without an object "data"`);
      return body.data;
    }
    if (body.ok === false && isRecord(body.error)) {
      const error = body.error;
      const code = typeof error.code === "string" && error.code ? error.code : "server_error";
      const message = typeof error.message === "string" && error.message ? error.message : `${method} failed`;
      throw new BridgeError(code, message, error.detail);
    }
    throw new BridgeError("invalid_response", `${method} returned an unrecognized envelope (HTTP ${response.status})`);
  }
}
