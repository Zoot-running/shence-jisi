/**
 * 集思 DSH 插件入口：绑定宿主能力并暴露 ctx.jisi 服务。
 * 模型清单由 llm-openai-compat 等适配器注册的 provider 路由动态提供。
 * @module @shence/jisi
 */

import type { Context } from '@deepseek-ai/cordis'
import { createJisiService } from './service.ts'

export const name = 'shence-jisi'
export const inject = ['subagents', 'llm']

export interface Config {
  /** ctx.subagents 的 provider 名（默认 spawn）。 */
  provider?: string
}

export function apply(ctx: Context, config: Config = {}): void {
  const provider = config.provider ?? 'spawn'
  ctx.provide('jisi', createJisiService(ctx, provider))
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    jisi: import('./service.ts').JisiService
  }
}
