/**
 * 集思通道宿主绑定（ADR-002 契约 → DSH 宿主能力）。
 * ctx.jisi 服务：delegate / fanout / listModels，按次指定模型。
 * 前台 = 一次性子代理结算；后台 = continuable 子代理（idle 后读会话日志终态）。
 * @module @shence/jisi/service
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { settleRun } from '@deepseek-ai/dsh-subagent'
import { JisiChannel, resolveProviderOfModel } from './channel.ts'
import type {
  Collector,
  DispatchOptions,
  DispatchResult,
  ModelInfo,
  Report,
  Spawner,
  WorkItem,
} from './types.ts'

/** 从子代理输出块提取纯文本。 */
function textOfBlocks(output: readonly ContentBlock[] | undefined): string {
  if (output === undefined) return ''
  return output.filter(b => b.type === 'text').map(b => (b.type === 'text' ? b.text : '')).join('')
}

/** 把子代理停因（字符串字面量）映射到通道报告状态。 */
function reportStatus(stopReason: string | undefined): Report['status'] {
  if (stopReason === 'completed') return 'completed'
  if (stopReason === 'aborted' || stopReason === 'error') return 'failed'
  // 未知/缺省：视为完成（有输出即有价值）。
  return 'completed'
}

/** ctx.jisi 服务面。 */
export interface JisiService {
  delegate(parent: Agent, work: WorkItem, opts?: DispatchOptions): DispatchResult
  fanout(parent: Agent, work: WorkItem, models: readonly string[], opts?: DispatchOptions): Promise<Report[]>
  listModels(): Promise<ModelInfo[]>
}

/** 绑定宿主能力，构造 ctx.jisi 服务。 */
export function createJisiService(ctx: Context, provider: string): JisiService {
  let currentParent: Agent | undefined

  const spawner: Spawner = {
    spawn(work, opts): DispatchResult {
      const parent = currentParent
      if (parent === undefined) {
        throw new Error('jisi: delegate requires a parent Agent (pass it explicitly to the service)')
      }
      const prompt = [{ type: 'text', text: work.prompt }] as ContentBlock[]
      const report = (async (): Promise<Report> => {
        if (opts.background === false) {
          // 前台：一次性子代理，等结算。
          // 路由解析：显式 LLM provider 优先；否则按 model 反查宿主 LLM provider。
          // 注意：ctx.subagents.start 的第一参数是子代理注册表的 provider（固定默认），
          // LLM 适配器路由只能经 agentOptions.provider 覆盖。
          const agentOptions: AgentOptions = {}
          if (opts.model !== undefined) agentOptions.model = opts.model
          let llmProvider = opts.provider
          if (llmProvider === undefined && opts.model !== undefined) {
            llmProvider = await resolveProviderOfModel(ctx.llm, opts.model)
          }
          if (llmProvider !== undefined) agentOptions.provider = llmProvider
          if (opts.reasoningEffort !== undefined) {
            agentOptions.reasoningEffort = opts.reasoningEffort as AgentOptions['reasoningEffort']
          }
          const run = await ctx.subagents.start(provider, {
            label: 'jisi-delegate',
            prompt,
            parent,
            signal: new AbortController().signal,
            ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
          })
          const result = await run.result
          void settleRun(run)
          return {
            status: reportStatus(result.stopReason),
            text: textOfBlocks(result.output),
          }
        }
        // 后台：v1 未实现服务端自等待。continuable 子代理的 settle 通知
        // 会送达父 agent（正是验证期主流程）；服务调用方请用 foreground。
        throw new Error('jisi: background delegate is not implemented in v1; use background:false, or await the subagent-settled notice in the parent agent')
      })()
      return { ref: { id: 'one-shot' }, report }
    },
  }

  const collector: Collector = {
    collect() {
      return Promise.resolve({ status: 'failed', text: 'jisi: collect is embedded in the dispatch promise' })
    },
  }

  const models = async (): Promise<ModelInfo[]> => {
    const out: ModelInfo[] = []
    for (const provider of ctx.llm.listProviders()) {
      const infos = await ctx.llm.listModels(provider.id)
      for (const info of infos) {
        out.push({ id: info.id, provider: info.provider })
      }
    }
    return out
  }

  const channel = new JisiChannel(spawner, collector, models)

  const withParent = <T>(parent: Agent, run: () => T): T => {
    currentParent = parent
    try {
      return run()
    } finally {
      currentParent = undefined
    }
  }

  return {
    delegate(parent, work, opts = {}) {
      return withParent(parent, () => channel.delegate(work, opts))
    },
    fanout(parent, work, models, opts = {}) {
      return withParent(parent, () => channel.fanout(work, models, opts))
    },
    listModels: () => channel.listModels(),
  }
}
