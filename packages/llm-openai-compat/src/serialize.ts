/**
 * Serialize harness messages into OpenAI-compatible chat completions.
 * 文本 + 工具调用/结果（不含图像/文件：兼容适配器面向通用对话模型）。
 * @module @shence/llm-openai-compat/serialize
 */

import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { ModelThinking } from './adapter.ts'
import type {
  WireMessage,
  WireRequest,
  WireTool,
} from './types.ts'

/** 把 harness 内容块序列化为 assistant 的纯文本（多个文本块拼接）。 */
function textOf(content: ContentBlock[]): string {
  let out = ''
  for (const block of content) {
    if (block.type === 'text') out += block.text
  }
  return out
}

/** 把 harness 消息序列化为 wire 消息。 */
export function serializeMessage(message: Message): WireMessage[] {
  const out: WireMessage[] = []
  switch (message.role) {
    case 'system': {
      out.push({ role: 'system', content: textOf(message.content) })
      return out
    }
    case 'user': {
      const texts = message.content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      if (texts.length === 1) {
        out.push({ role: 'user', content: texts[0]!.text })
      } else {
        out.push({ role: 'user', content: texts.map(t => ({ type: 'text', text: t.text })) })
      }
      return out
    }
    case 'assistant': {
      const toolCalls: WireMessage[] = message.content
        .filter((b): b is Extract<ContentBlock, { type: 'tool-call' }> => b.type === 'tool-call')
        .map(b => ({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: b.arguments },
        }))
      const reasoning = message.content.find(b => b.type === 'reasoning')
      out.push({
        role: 'assistant',
        content: textOf(message.content) || (toolCalls.length > 0 ? '' : null),
        ...(reasoning && reasoning.type === 'reasoning' ? { reasoning_content: reasoning.text } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      })
      return out
    }
    default:
      return out
  }
}

/** 把一条 harness 消息序列化为 wire 消息；tool-result 特化单独处理。 */
export function serializeMessages(messages: Message[]): WireMessage[] {
  const out: WireMessage[] = []
  for (const message of messages) {
    // tool-result：harness 用 user 角色 + ToolResultBlock；wire 用 role=tool。
    const result = message.content.find(b => b.type === 'tool-result')
    if (message.role === 'user' && result && result.type === 'tool-result') {
      out.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        content: result.content.filter(b => b.type === 'text').map(b => (b.type === 'text' ? b.text : '')).join(''),
      })
      continue
    }
    out.push(...serializeMessage(message))
  }
  return out
}

/** 组装完整 wire 请求；thinking 配置把 reasoningEffort 映射为提供方私有参数。 */
export function buildRequest(options: GenerateOptions, thinking?: ModelThinking): WireRequest {
  const request: WireRequest = {
    model: options.model,
    messages: serializeMessages(options.messages),
    stream: true,
    stream_options: { include_usage: true },
  }
  if (options.system !== undefined && options.system.length > 0) {
    request.messages = [{ role: 'system', content: options.system }, ...request.messages]
  }
  if (options.tools !== undefined && options.tools.length > 0) {
    request.tools = options.tools.map((t): WireTool => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
  }
  if (options.temperature !== undefined) request.temperature = options.temperature
  if (options.maxTokens !== undefined) request.max_tokens = options.maxTokens
  if (options.stop !== undefined && options.stop.length > 0) request.stop = options.stop
  if (thinking !== undefined && options.reasoningEffort !== undefined) {
    const effort = String(options.reasoningEffort)
    const value = thinking.efforts[effort] ?? thinking.efforts[thinking.defaultEffort ?? '']
    if (value !== undefined) request[thinking.param] = value
  }
  return request
}
