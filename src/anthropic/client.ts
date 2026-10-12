import { parseSse } from "./sse.js";
import type {
  ContentBlock,
  Message,
  MessageRequest,
  StreamEvent,
  ToolUseBlock,
} from "./types.js";

export interface StreamHandlers {
  onText?: (text: string) => void;
  onToolUseStart?: (block: ToolUseBlock) => void;
}

/** The only thing the agent needs from a model client. Easy to fake in tests. */
export interface MessagesClient {
  stream(request: MessageRequest, handlers?: StreamHandlers): Promise<Message>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly errorType: string,
    message: string,
  ) {
    super(`Anthropic API error ${status} (${errorType}): ${message}`);
    this.name = "ApiError";
  }

  get retryable(): boolean {
    return this.status === 429 || this.status === 529 || this.status >= 500;
  }
}

export interface HttpClientOptions {
  apiKey: string;
  baseUrl?: string;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const API_VERSION = "2023-06-01";

export class HttpMessagesClient implements MessagesClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: HttpClientOptions) {
    if (!options.apiKey) throw new Error("An Anthropic API key is required.");
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
    this.maxRetries = options.maxRetries ?? 3;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async stream(request: MessageRequest, handlers: StreamHandlers = {}): Promise<Message> {
    const response = await this.requestWithRetry(request);
    if (!response.body) throw new Error("Streaming response had no body.");
    return accumulateStream(parseEvents(response.body), handlers);
  }

  private async requestWithRetry(request: MessageRequest): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": API_VERSION,
        },
        body: JSON.stringify({ ...request, stream: true }),
      });

      if (response.ok) return response;

      const error = await toApiError(response);
      if (!error.retryable || attempt >= this.maxRetries) throw error;
      await this.sleep(retryDelayMs(response, attempt));
    }
  }
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  const base = 500 * 2 ** attempt;
  return base + Math.random() * base * 0.25;
}

async function toApiError(response: Response): Promise<ApiError> {
  let errorType = "unknown_error";
  let message = response.statusText;
  try {
    const body = (await response.json()) as { error?: { type?: string; message?: string } };
    errorType = body.error?.type ?? errorType;
    message = body.error?.message ?? message;
  } catch {
    // Non-JSON error body; keep the status text.
  }
  return new ApiError(response.status, errorType, message);
}

async function* parseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  for await (const sse of parseSse(body)) {
    yield JSON.parse(sse.data) as StreamEvent;
  }
}

/**
 * Folds a stream of Messages API events into a final Message, invoking
 * handlers as text arrives. Exported for testing without a network.
 */
export async function accumulateStream(
  events: AsyncIterable<StreamEvent>,
  handlers: StreamHandlers = {},
): Promise<Message> {
  let message: Message | undefined;
  const partialJson = new Map<number, string>();

  for await (const event of events) {
    switch (event.type) {
      case "message_start":
        message = { ...event.message, content: [] };
        break;

      case "content_block_start": {
        const block = cloneBlock(event.content_block);
        requireMessage(message).content[event.index] = block;
        if (block.type === "tool_use") {
          partialJson.set(event.index, "");
          handlers.onToolUseStart?.(block);
        }
        break;
      }

      case "content_block_delta": {
        const block = requireMessage(message).content[event.index];
        if (event.delta.type === "text_delta" && block?.type === "text") {
          block.text += event.delta.text;
          handlers.onText?.(event.delta.text);
        } else if (event.delta.type === "input_json_delta") {
          partialJson.set(event.index, (partialJson.get(event.index) ?? "") + event.delta.partial_json);
        }
        break;
      }

      case "content_block_stop": {
        const block = requireMessage(message).content[event.index];
        const json = partialJson.get(event.index);
        if (block?.type === "tool_use" && json !== undefined) {
          block.input = json.trim() ? (JSON.parse(json) as Record<string, unknown>) : {};
          partialJson.delete(event.index);
        }
        break;
      }

      case "message_delta": {
        const msg = requireMessage(message);
        msg.stop_reason = event.delta.stop_reason;
        msg.usage = { ...msg.usage, ...stripNullish(event.usage) };
        break;
      }

      case "error":
        throw new ApiError(500, event.error.type, event.error.message);

      case "message_stop":
      case "ping":
        break;
    }
  }

  return requireMessage(message);
}

function cloneBlock(block: ContentBlock): ContentBlock {
  return block.type === "text"
    ? { type: "text", text: block.text }
    : { type: "tool_use", id: block.id, name: block.name, input: { ...block.input } };
}

function requireMessage(message: Message | undefined): Message {
  if (!message) throw new Error("Received stream event before message_start.");
  return message;
}

function stripNullish<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, value]) => value !== null && value !== undefined),
  ) as Partial<T>;
}
