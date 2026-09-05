/**
 * llm-openai-compat 插件：从配置注册多条 OpenAI 兼容 provider 路由。
 * 每条路由：provider 名、baseURL、apiKeyEnv、模型目录。
 * @module @shence/llm-openai-compat
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import { OpenAICompatAdapter } from './adapter.ts'
import type { RouteFacts } from './adapter.ts'

export const name = 'llm-openai-compat'
export const inject = ['llm']

export interface RouteConfig {
  provider: string
  baseURL: string
  apiKeyEnv: string
  models?: Array<{ id: string; name: string; description?: string }>
}

export interface Config {
  routes: RouteConfig[]
}

export const Config: z<Config> = z.object({
  routes: z.array(
    z.object({
      provider: z.string().required(),
      baseURL: z.string().required(),
      apiKeyEnv: z.string().required(),
      models: z.array(
        z.object({
          id: z.string().required(),
          name: z.string().required(),
          description: z.string(),
        }),
      ),
    }),
  ).min(1),
})

export function apply(ctx: Context, config: Config): void {
  const routes = new Map<string, RouteFacts>()
  for (const route of config.routes) {
    const models: LlmModelInfo[] = (route.models ?? []).map(m => ({
      provider: route.provider,
      id: m.id,
      name: m.name,
      ...(m.description !== undefined ? { description: m.description } : {}),
    }))
    routes.set(route.provider, {
      baseURL: route.baseURL,
      apiKeyEnv: route.apiKeyEnv,
      models,
    })
  }
  ctx.llm.registerAdapter([...routes.keys()], new OpenAICompatAdapter(routes))
}
