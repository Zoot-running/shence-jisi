/**
 * 集思通道宿主绑定（ADR-002 契约 → DSH 宿主能力）。
 * ctx.jisi 服务：delegate / fanout / listModels，按次指定模型。
 * 前台一次性子代理（run.result 结算），父 Agent 由调用方显式传入。
 * @module @shence/jisi/service
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { settleRun } from '@deepseek-ai/dsh-subagent'
import { JisiChannel } from './channel.ts'
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

/** 把子代理停因映射到通道报告状态。 */
function reportStatus(kind: string | undefined): Report['status'] {
  return kind === 'completed' || kind === 'blocked' ? (kind === 'completed' ? 'completed' : 'blocked') : 'failed'
}

/** ctx.jisi 服务面。 */
export interface JisiService {
  delegate(parent: Agent, work: WorkItem, opts?: DispatchOptions): DispatchResult
  fanout(parent: Agent, work: WorkItem, models: readonly string[]): Promise<Report[]>
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
      const agentOptions: AgentOptions = {
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
      }
      const report = (async (): Promise<Report> => {
        const run = await ctx.subagents.start(provider, {
          label: 'jisi-delegate',
          prompt: [{ type: 'text', text: work.prompt }] as ContentBlock[],
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
      })()
      return { ref: { id: 'one-shot' }, report }
    },
  }

  const collector: Collector = {
    collect() {
      return Promise.resolve({ status: 'failed', text: 'jisi: collect is embedded in the dispatch promise for one-shot runs' })
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
    fanout(parent, work, models) {
      return withParent(parent, () => channel.fanout(work, models))
    },
    listModels: () => channel.listModels(),
  }
}
