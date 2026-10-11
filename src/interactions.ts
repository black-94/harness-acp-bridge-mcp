/**
 * Reverse-request resolution through MCP elicitation.
 *
 * When the connected client advertised **form** elicitation, permission and information
 * questions are answered with an MCP `elicitation/create` request: offered options are mapped
 * back to their exact `optionId`, and nothing is ever auto-approved. A client that supports
 * only URL elicitation (or none) cannot answer a form, so `resolve` returns `undefined` and the
 * caller surfaces `waiting_input`. Any answer is validated against the harness's *full*
 * original schema before it is sent; an unrepresentable schema or an invalid answer likewise
 * returns `undefined` rather than sending an accept that violates the constraints.
 */
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Ajv } from "ajv";
import addFormats from "ajv-formats";
import { isRecord } from "./config.js";

export type QuestionKind = "permission" | "information" | "elicitation";

export interface Question {
  request_id: string;
  kind: QuestionKind;
  title: string;
  message: string;
  options: Record<string, unknown>[];
  schema: Record<string, unknown> | null;
  raw?: Record<string, unknown>;
}

export type Decision =
  | { answer: "accept"; option_id: string }
  | { answer: "accept"; content: Record<string, unknown> }
  | { answer: "reject" | "timeout" | "cancel" };

interface FormProperty { type: string; title?: string; description?: string; enum?: string[]; enumNames?: string[]; minLength?: number; maxLength?: number; format?: string; minimum?: number; maximum?: number }
type FormSchema = { type: "object"; properties: Record<string, FormProperty>; required?: string[] };

const FORM_FORMATS = new Set(["date", "uri", "email", "date-time"]);
const STRING_KEYS = new Set(["type", "title", "description", "minLength", "maxLength", "format", "enum", "enumNames", "default"]);
const NUMBER_KEYS = new Set(["type", "title", "description", "minimum", "maximum", "default"]);
const BOOLEAN_KEYS = new Set(["type", "title", "description", "default"]);

const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: true });
(addFormats as unknown as (validator: Ajv) => void)(ajv);

/** Map a harness schema onto the restricted MCP form schema; null when it cannot be represented losslessly. */
function toFormSchema(schema: Record<string, unknown> | null): FormSchema | null {
  if (!isRecord(schema) || schema.type !== "object" || !isRecord(schema.properties)) return null;
  // `additionalProperties: false` is compatible with the restricted form schema (which already
  // forbids extra fields), and the server's auth question schemas set it.
  for (const key of Object.keys(schema)) if (!["type", "properties", "required", "additionalProperties"].includes(key)) return null;
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) return null;
  const properties: Record<string, FormProperty> = {};
  for (const [key, value] of Object.entries(schema.properties)) {
    if (!isRecord(value)) return null;
    const type = value.type;
    const keys = Object.keys(value);
    if (type === "string") {
      if (keys.some(k => !STRING_KEYS.has(k))) return null;
      if (value.format !== undefined && (typeof value.format !== "string" || !FORM_FORMATS.has(value.format))) return null;
      const property: FormProperty = { type: "string" };
      if (typeof value.title === "string") property.title = value.title;
      if (typeof value.description === "string") property.description = value.description;
      if (typeof value.minLength === "number") property.minLength = value.minLength;
      if (typeof value.maxLength === "number") property.maxLength = value.maxLength;
      if (typeof value.format === "string") property.format = value.format;
      if (Array.isArray(value.enum)) {
        if (!value.enum.every(item => typeof item === "string")) return null;
        property.enum = value.enum as string[];
        if (Array.isArray(value.enumNames) && value.enumNames.every(item => typeof item === "string")) property.enumNames = value.enumNames as string[];
      }
      properties[key] = property;
    } else if (type === "boolean") {
      // A `boolean` field may carry an `enum` (e.g. the auth URL/device-code confirm question uses
      // `{ opened: { type: "boolean", enum: [true] } }`). The restricted form schema cannot express
      // an enum on a boolean, so emit a plain boolean and keep the full-schema check in `form()`,
      // which rejects a value the harness did not offer.
      const extra = keys.filter(k => !BOOLEAN_KEYS.has(k));
      if (extra.some(k => k !== "enum")) return null;
      if (keys.includes("enum") && (!Array.isArray(value.enum) || !value.enum.every(item => typeof item === "boolean"))) return null;
      properties[key] = { type: "boolean", ...(typeof value.title === "string" ? { title: value.title } : {}), ...(typeof value.description === "string" ? { description: value.description } : {}) };
    } else if (type === "integer" || type === "number") {
      if (keys.some(k => !NUMBER_KEYS.has(k))) return null;
      properties[key] = {
        type, ...(typeof value.title === "string" ? { title: value.title } : {}), ...(typeof value.description === "string" ? { description: value.description } : {}),
        ...(typeof value.minimum === "number" ? { minimum: value.minimum } : {}), ...(typeof value.maximum === "number" ? { maximum: value.maximum } : {}),
      };
    } else return null;
  }
  if (Object.keys(properties).length === 0) return null;
  const required = Array.isArray(schema.required) ? (schema.required as unknown[]).filter(item => typeof item === "string") as string[] : undefined;
  return { type: "object", properties, ...(required && required.length ? { required } : {}) };
}

/** Validate an accepted answer against the full original schema, so no constraint is silently dropped. */
function validateAgainst(schema: Record<string, unknown> | null, content: Record<string, unknown>): boolean {
  if (!schema) return true;
  try { return ajv.compile(schema)(content) === true; }
  catch { return false; } // an unsupported keyword means we cannot prove the answer valid
}

function toolInput(question: Question): string {
  const params = isRecord(question.raw) && isRecord(question.raw.params) ? question.raw.params : null;
  const toolCall = params && isRecord(params.toolCall) ? params.toolCall : null;
  const input = toolCall?.rawInput;
  return input === undefined ? "" : `\n${JSON.stringify(input)}`;
}

export interface InteractionHandler {
  resolve(question: Question, signal: AbortSignal): Promise<Decision | undefined>;
}

function isValidationError(error: unknown): boolean {
  return error instanceof McpError && error.code === ErrorCode.InvalidParams;
}

export class ElicitationHandler implements InteractionHandler {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly server: McpServer, private readonly timeoutMs: number) {}

  /**
   * Form elicitation only. A client advertising just `url` (or neither) cannot answer a form;
   * an empty elicitation object is the legacy "form" default.
   */
  supportsElicitation(): boolean {
    const capabilities = this.server.server.getClientCapabilities() as { elicitation?: { form?: unknown; url?: unknown } } | undefined;
    const elicitation = capabilities?.elicitation;
    if (!elicitation) return false;
    if (elicitation.form) return true;
    return elicitation.url === undefined || elicitation.url === null; // legacy empty object defaults to form
  }

  resolve(question: Question, signal: AbortSignal): Promise<Decision | undefined> {
    if (!this.supportsElicitation()) return Promise.resolve(undefined);
    const result = this.tail.catch(() => {}).then(async () => {
      signal.throwIfAborted();
      try {
        return question.kind === "permission" ? await this.permission(question, signal) : await this.form(question, signal);
      } catch (error) {
        // An invalid elicitation answer leaves the question pending rather than failing the turn.
        if (isValidationError(error)) return undefined;
        throw error;
      }
    });
    this.tail = result;
    return result;
  }

  private async elicit(message: string, requestedSchema: FormSchema, signal: AbortSignal) {
    try {
      return await this.server.server.elicitInput({ mode: "form", message, requestedSchema } as never, { signal, timeout: this.timeoutMs });
    } catch (error) {
      if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) return { action: "timeout" as const, content: undefined };
      throw error;
    }
  }

  private async permission(question: Question, signal: AbortSignal): Promise<Decision | undefined> {
    const offered = question.options.filter(option => typeof option.optionId === "string");
    if (offered.length === 0) return undefined;
    const ids = offered.map(option => String(option.optionId));
    const names = offered.map(option => String(option.name ?? option.optionId));
    const requestedSchema: FormSchema = {
      type: "object",
      properties: { option_id: { type: "string", title: question.title || "Permission", description: `Choose one: ${names.map((name, index) => `${ids[index]} = ${name}`).join(", ")}`, enum: ids, enumNames: names } },
      required: ["option_id"],
    };
    const result = await this.elicit(`${question.title || "Permission request"}\n${question.message}${toolInput(question)}`, requestedSchema, signal);
    if (result.action === "timeout") return { answer: "timeout" };
    if (result.action === "cancel") return { answer: "cancel" };
    if (result.action === "decline") return { answer: "reject" };
    const selected = isRecord(result.content) ? result.content.option_id : undefined;
    if (typeof selected !== "string" || !ids.includes(selected)) return undefined; // never approve an unoffered option
    return { answer: "accept", option_id: selected };
  }

  private async form(question: Question, signal: AbortSignal): Promise<Decision | undefined> {
    const requestedSchema = toFormSchema(question.schema);
    if (!requestedSchema) return undefined;
    const result = await this.elicit(`${question.title || "Input required"}\n${question.message}${toolInput(question)}`, requestedSchema, signal);
    if (result.action === "timeout") return { answer: "timeout" };
    if (result.action === "cancel") return { answer: "cancel" };
    if (result.action === "decline") return { answer: "reject" };
    const content = isRecord(result.content) ? result.content : {};
    if (!validateAgainst(question.schema, content)) return undefined; // keep the full schema's constraints
    return { answer: "accept", content };
  }
}
