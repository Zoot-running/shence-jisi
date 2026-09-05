/**
 * L0：llm-openai-compat 思考强度映射（buildRequest）。
 * reasoningEffort → 提供方私有 wire 参数（thinking 等），纯序列化逻辑。
 */
import { describe, expect, it } from 'vitest'
import { buildRequest } from '../packages/llm-openai-compat/src/serialize.ts'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { ModelThinking } from '../packages/llm-openai-compat/src/adapter.ts'

const thinking: ModelThinking = {
  param: 'thinking',
  efforts: {
    off: { type: 'disabled' },
    high: { type: 'enabled' },
    max: { type: 'enabled', thinking_budget: 32768 },
  },
  defaultEffort: 'high',
  names: { off: 'Off', high: 'High', max: 'Max' },
}

function options(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'zhipu-official',
    model: 'glm-4.6',
    messages: [],
    ...overrides,
  } as unknown as GenerateOptions
}

describe('buildRequest reasoningEffort mapping', () => {
  it('injects the provider param for a selected effort', () => {
    const request = buildRequest(options({ reasoningEffort: 'max' as never }), thinking)
    expect(request.thinking).toEqual({ type: 'enabled', thinking_budget: 32768 })
  })

  it('falls back to defaultEffort for an unknown effort id', () => {
    const request = buildRequest(options({ reasoningEffort: 'nope' as never }), thinking)
    expect(request.thinking).toEqual({ type: 'enabled' })
  })

  it('omits the param entirely when no effort is requested', () => {
    const request = buildRequest(options(), thinking)
    expect('thinking' in request).toBe(false)
  })

  it('omits the param when the model has no thinking config', () => {
    const request = buildRequest(options({ reasoningEffort: 'max' as never }))
    expect('thinking' in request).toBe(false)
  })

  it('keeps base request fields intact alongside thinking', () => {
    const request = buildRequest(options({ reasoningEffort: 'high' as never, maxTokens: 4096 }), thinking)
    expect(request.model).toBe('glm-4.6')
    expect(request.max_tokens).toBe(4096)
    expect(request.stream).toBe(true)
    expect(request.thinking).toEqual({ type: 'enabled' })
  })
})
