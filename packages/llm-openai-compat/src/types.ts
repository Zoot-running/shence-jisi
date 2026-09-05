/**
 * OpenAI-compatible wire vocabulary（from dsh-llm-deepseek，通用协议形状）。
 * @module @shence/llm-openai-compat/types
 */

export interface WireRequest {
  model: string
  messages: WireMessage[]
  stream: true
  stream_options: { include_usage: true }
  tools?: WireTool[]
  temperature?: number
  max_tokens?: number
  stop?: string[]
}

/** System-role message: a single string of instructions. */
export interface WireSystemMessage {
  role: 'system'
  content: string
}

/** Text part inside a multimodal user message. */
export interface WireTextContentPart {
  type: 'text'
  text: string
}

/** Ordered input part accepted by a multimodal user message. */
export type WireUserContentPart = WireTextContentPart

/** User-role message: text-only string or ordered input. */
export interface WireUserMessage {
  role: 'user'
  content: string | WireUserContentPart[]
}

/** Tool-role message: the result of one tool call, keyed by its call id. */
export interface WireToolMessage {
  role: 'tool'
  tool_call_id: string
  content: string
}

/** One entry of the request `messages` array, discriminated on `role`. */
export type WireMessage =
  | WireSystemMessage
  | WireUserMessage
  | WireAssistantMessage
  | WireToolMessage

/** Assistant-role history message. */
export interface WireAssistantMessage {
  role: 'assistant'
  content: string | null
  reasoning_content?: string
  tool_calls?: WireToolCall[]
}

/** A completed tool call replayed on an assistant history message. */
export interface WireToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** One entry of the request `tools` array. */
export interface WireTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/** One parsed SSE `data:` payload (a chat.completion.chunk). */
export interface WireChunk {
  choices?: WireChoice[]
  usage?: WireUsage | null
}

/** One streamed choice; `finish_reason` non-null only on its terminal chunk. */
export interface WireChoice {
  delta?: WireDelta
  finish_reason?: string | null
}

/** The incremental content of one streamed choice. */
export interface WireDelta {
  role?: string
  content?: string | null
  reasoning_content?: string | null
  tool_calls?: WireToolCallDelta[]
}

/** A streamed fragment of one tool call. */
export interface WireToolCallDelta {
  index: number
  id?: string | null
  type?: 'function'
  function?: {
    name?: string | null
    arguments?: string | null
  }
}

/** Wire token accounting (OpenAI-compat). */
export interface WireUsage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens?: number
  prompt_cache_hit_tokens?: number
  prompt_cache_miss_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

/** Non-2xx error body. */
export interface WireError {
  error?: { message?: string; type?: string; code?: string }
}
