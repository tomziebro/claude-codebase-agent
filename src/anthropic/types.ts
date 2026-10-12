// Typed subset of the Anthropic Messages API used by this project.
// Reference: https://docs.claude.com/en/api/messages

export type Role = "user" | "assistant";

export interface CacheControl {
  type: "ephemeral";
}

export interface TextBlock {
  type: "text";
  text: string;
  cache_control?: CacheControl;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
  cache_control?: CacheControl;
}

export type ContentBlock = TextBlock | ToolUseBlock;
export type RequestContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface MessageParam {
  role: Role;
  content: string | RequestContentBlock[];
}

export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: JsonSchema;
  cache_control?: CacheControl;
}

export interface MessageRequest {
  model: string;
  max_tokens: number;
  system?: string | TextBlock[];
  messages: MessageParam[];
  tools?: ToolDefinition[];
  temperature?: number;
}

export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "stop_sequence"
  | "tool_use"
  | "pause_turn"
  | "refusal";

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export interface Message {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: ContentBlock[];
  stop_reason: StopReason | null;
  usage: Usage;
}

// ---- Streaming events -------------------------------------------------------

export type StreamEvent =
  | { type: "message_start"; message: Message }
  | { type: "content_block_start"; index: number; content_block: ContentBlock }
  | {
      type: "content_block_delta";
      index: number;
      delta:
        | { type: "text_delta"; text: string }
        | { type: "input_json_delta"; partial_json: string };
    }
  | { type: "content_block_stop"; index: number }
  | {
      type: "message_delta";
      delta: { stop_reason: StopReason | null };
      usage: Partial<Usage>;
    }
  | { type: "message_stop" }
  | { type: "ping" }
  | { type: "error"; error: { type: string; message: string } };
