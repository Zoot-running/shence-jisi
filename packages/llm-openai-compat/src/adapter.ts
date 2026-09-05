/**
 * OpenAI-compatible adapter：多路由（每路由独立 baseURL/apiKeyEnv/models）。
 * 每请求解析连接事实（设置/环境变量变更即时生效）；流式 SSE → harness StreamChunk。
 * @module @shence/llm-openai-compat/adapter
 */

import { attributionHeaders, assertUsableApiKey, LlmError, LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmModelReasoningInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { buildRequest } from './serialize.ts'
import { parseSse } from './sse.ts'
import { translate } from './translate.ts'
import type { WireError, WireRequest } from './types.ts'

/** 单模型思考能力：effort id → wire 值（原样 JSON 注入到请求）。 */
export interface ModelThinking {
  /** wire 参数名（如 thinking）。 */
  readonly param: string
  /** effort id → wire 值；调用方 reasoningEffort 在此查找。 */
  readonly efforts: Readonly<Record<string, unknown>>
  /** 调用方未指定 effort 时应用的默认 id。 */
  readonly defaultEffort?: string
  /** effort id → 展示名（选型/诊断用）。 */
  readonly names?: Readonly<Record<string, string>>
}

export interface CompatModelInfo extends LlmModelInfo {
  thinking?: ModelThinking
}

/** 单路由静态事实（注册时确定）；apiKey 每请求解析。 */
export interface RouteFacts {
  readonly baseURL: string
  readonly apiKeyEnv: string
  readonly models: readonly CompatModelInfo[]
}

/** 运行时解析的连接事实。 */
interface ConnectionFacts {
  readonly baseURL: string
  readonly apiKey: string
}

function resolveConnection(facts: RouteFacts): ConnectionFacts {
  const raw = process.env[facts.apiKeyEnv]
  if (raw === undefined || raw.length === 0) {
    throw new LlmError(`missing API key for env "${facts.apiKeyEnv}"`, 'MISSING_CREDENTIAL')
  }
  return {
    baseURL: facts.baseURL.replace(/\/+$/, ''),
    apiKey: assertUsableApiKey(raw, '@shence/llm-openai-compat', facts.apiKeyEnv),
  }
}

export class OpenAICompatAdapter extends LlmAdapter {
  constructor(private readonly routes: ReadonlyMap<string, RouteFacts>) {
    super()
  }

  providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: provider }
  }

  async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = this.routes.get(provider)?.models ?? []
    return models.map(({ thinking: _thinking, ...model }) => model)
  }

  async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const compat = this.routes.get(provider)?.models.find(m => m.id === model)
    const effortIds = Object.keys(compat?.thinking?.efforts ?? {})
    const reasoning: LlmModelReasoningInfo | undefined = compat?.thinking !== undefined && effortIds.length > 0
      ? {
          efforts: effortIds.map(id => ({
            id: ReasoningEffortId(id),
            name: compat.thinking!.names?.[id] ?? id,
          })),
          ...(compat.thinking.defaultEffort !== undefined
            ? { defaultEffort: ReasoningEffortId(compat.thinking.defaultEffort) }
            : {}),
        }
      : undefined
    return {
      provider,
      id: model,
      name: compat?.name ?? model,
      ...(reasoning !== undefined ? { reasoning } : {}),
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const facts = this.routes.get(options.provider)
    if (facts === undefined) {
      throw new LlmError(`unregistered provider route "${options.provider}"`, 'UNKNOWN_PROVIDER')
    }
    const connection = resolveConnection(facts)
    const thinking = facts.models.find(m => m.id === options.model)?.thinking
    const request: WireRequest = buildRequest(options, thinking)

    let response: Response
    try {
      response = await fetch(`${connection.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          ...attributionHeaders(),
          'content-type': 'application/json',
          authorization: `Bearer ${connection.apiKey}`,
        },
        body: JSON.stringify(request),
        signal: options.signal,
      })
    } catch (error) {
      if (options.signal?.aborted) {
        yield { type: 'finish', reason: { kind: 'aborted' } }
        return
      }
      throw new LlmError(`request to ${connection.baseURL} failed: ${String(error)}`, 'TRANSPORT', { cause: error })
    }

    if (!response.ok) {
      let detail = ''
      try {
        const body = (await response.json()) as WireError
        detail = body.error?.message ?? ''
      } catch {
        /* 忽略错误体解析失败 */
      }
      yield {
        type: 'finish',
        reason: { kind: 'error', error: { message: detail || `provider ${response.status}`, code: 'PROVIDER_ERROR', status: response.status } },
      }
      return
    }

    if (response.body === null) {
      yield { type: 'finish', reason: { kind: 'error', error: { message: 'empty response body', code: 'EMPTY_RESPONSE' } } }
      return
    }

    for await (const chunk of translate(parseSse(response.body))) {
      yield chunk
    }
  }
}
