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
import type { ModelLedger } from './model-ledger.ts'
import type {
  Collector,
  DispatchOptions,
  DispatchResult,
  FanoutTicket,
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

/**
 * 目标模型是否宣告支持给定 effort。
 * llmProvider/model 未知时保守返回 false（不透传，交给模型默认行为）。
 */
async function effortSupported(
  llm: { resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{ reasoning?: { efforts?: readonly { id: unknown }[] } }> },
  llmProvider: string | undefined,
  model: string | undefined,
  effort: string,
): Promise<boolean> {
  if (llmProvider === undefined || model === undefined) return false
  try {
    const info = await llm.resolveModelInfo(llmProvider, model)
    return info.reasoning?.efforts?.some(e => String(e.id) === effort) ?? false
  } catch {
    return false
  }
}

/**
 * provider 目录里是否确实宣告了该模型。
 * 正向验证：防目录状态不一致时模型被误送到错误 provider（F8：glm 被送到 deepseek-official）。
 */
async function modelListedOnProvider(
  catalog: { listModels(provider: string): Promise<ReadonlyArray<{ id: string }>> },
  provider: string,
  model: string,
): Promise<boolean> {
  try {
    for (const info of await catalog.listModels(provider)) {
      if (info.id === model) return true
    }
  } catch { /* 目录查询失败按未宣告处理 */ }
  return false
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
  /**
   * fanout（collect 语义）：并发征集，全部结算后返回（可带 timeoutMs 超时，
   * 超时返回已结算子集并中止其余）。每份报告附 model 与信封。
   */
  fanout(parent: Agent, work: WorkItem, models: readonly string[], opts?: DispatchOptions): Promise<Array<Report & { model: string }>>
  /**
   * fanout（notify 语义，缺省）：立即返回票据；每路子代理 settle 后结果
   * 独立送达父 agent 上下文（先完成先到，不等最慢的）。
   */
  fanoutNotify(parent: Agent, work: WorkItem, models: readonly string[], opts?: DispatchOptions): FanoutTicket
  /** 丢弃 fanout：中止所有未结算路（停思考省 token）；迟到通知按票据 id 忽略。 */
  fanoutDrop(id: string): boolean
  listModels(): Promise<ModelInfo[]>
  /** 续聊 continuable 子代理（保留原生上下文；答案经父 agent 会话上下文回流）。 */
  continue(parent: Agent, childId: string, message: string): Promise<void>
  /** 模型能力账本（越用越了解模型；记录/排序/摘要）。 */
  ledger: {
    record(model: string, dimension: 'execution' | 'idea', key: string, win: boolean): void
    rank(dimension: 'execution' | 'idea', key: string, candidates: readonly string[], priceOrder?: readonly string[]): string[]
    summary(): Array<{ model: string; dimension: string; key: string; attempts: number; wins: number; rate: number }>
  }
}

/** 绑定宿主能力，构造 ctx.jisi 服务。 */
export function createJisiService(
  ctx: Context,
  provider: string,
  modelLedger: ModelLedger,
  onLedgerChange: () => void,
): JisiService {
  let currentParent: Agent | undefined
  const continuables = new Map<string, Agent>()

  const spawner: Spawner = {
    spawn(work, opts): DispatchResult {
      const parent = currentParent
      if (parent === undefined) {
        throw new Error('jisi: delegate requires a parent Agent (pass it explicitly to the service)')
      }
      const prompt = [{ type: 'text', text: work.prompt }] as ContentBlock[]
      const report = (async (): Promise<Report> => {
        // 路由解析：显式 LLM provider 优先；否则按 model 反查宿主 LLM provider。
        // 注意：ctx.subagents.start 的第一参数是子代理注册表的 provider（固定默认），
        // LLM 适配器路由只能经 agentOptions.provider 覆盖。
        const agentOptions: AgentOptions = {}
        if (opts.model !== undefined) agentOptions.model = opts.model
        let llmProvider = opts.provider
        if (llmProvider === undefined && opts.model !== undefined) {
          llmProvider = await resolveProviderOfModel(ctx.llm, opts.model)
          // F8：解析不到 provider 时禁止静默回落父路由（模型会被误送到默认 provider，
          // 子代理拿到"provider 不支持该模型"错误后无声死亡，落账 detail 为空）。
          if (llmProvider === undefined) {
            return { status: 'failed', text: `[no-provider-for-model] 模型 ${opts.model} 未出现在任何已注册 provider 的目录中；拒绝派单（不静默回落默认路由）` }
          }
        }
        // 正向验证：目标 provider 确实宣告该模型（目录不一致时同样响亮失败而非误送）。
        if (llmProvider !== undefined && opts.model !== undefined) {
          if (!(await modelListedOnProvider(ctx.llm, llmProvider, opts.model))) {
            return { status: 'failed', text: `[model-not-on-provider] provider ${llmProvider} 的目录中没有模型 ${opts.model}；拒绝派单` }
          }
        }
        if (llmProvider !== undefined) agentOptions.provider = llmProvider
        if (opts.reasoningEffort !== undefined) {
          // effort 是 adapter 自有语义：只有目标模型宣告支持该 effort 才透传，
          // 否则 DSH 子代理会因未宣告的 effort 静默失败（实测 kimi-k2.6 + high 即如此）。
          const supported = await effortSupported(ctx.llm, llmProvider, opts.model, opts.reasoningEffort)
          if (supported) {
            agentOptions.reasoningEffort = opts.reasoningEffort as AgentOptions['reasoningEffort']
          }
        }
        if (opts.background === true) {
          // 后台 = continuable 子代理：初始 prompt 入箱即返；续聊经 jisi.continue；
          // 子代理每次 settle 的通知直达父 agent 会话上下文（主 agent 下一轮读到答案，
          // 与老架构一致的"续战"机制）。终态由调用方（虎符/主 agent）显式 report。
          try {
            const started = await ctx.subagents.startContinuable({
              provider,
              label: 'jisi-delegate',
              request: {
                prompt,
                parent,
                ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
              },
              signal: opts.signal ?? new AbortController().signal,
            })
            continuables.set(started.childId, parent)
            return { status: 'completed', text: '' } // 占位：continuable 无一次性终态
          } catch (error) {
            // 启动失败要显式可见（虎符 binding 会把 failed 报告喂给账本）。
            return { status: 'failed', text: `[continuable-start-failed] ${String(error)}` }
          }
        }
        // 前台：一次性子代理，等结算。
        const run = await ctx.subagents.start(provider, {
          label: 'jisi-delegate',
          prompt,
          parent,
          signal: opts.signal ?? new AbortController().signal,
          ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
        })
        const result = await run.result
        void settleRun(run)
        const output = textOfBlocks(result.output)
        // 非 completed 停因：把提供方诊断附在文本上（下游虎符/runner 据此分流限流重试）。
        const diagnostic = result.stopReason !== 'completed' && result.diagnostic !== undefined && result.diagnostic !== ''
          ? `\n[diagnostic] ${result.diagnostic}`
          : ''
        return {
          status: reportStatus(result.stopReason),
          text: output + diagnostic,
        }
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

  // ── fanout 管理器（notify/collect/drop 三语义） ──
  let fanoutSeq = 0
  const fanouts = new Map<string, { controller: AbortController; models: string[]; dropped: boolean }>()

  /** 信封：把问题摘要与票据 id 烘焙进子代理 prompt，输出可溯源（多 fanout 交错不乱）。 */
  function envelope(prompt: string, id: string, model: string): string {
    const summary = prompt.replace(/\s+/g, ' ').trim().slice(0, 40)
    return [
      `[fanout:${id}] [model:${model}] [question:${summary}]`,
      '',
      prompt,
      '',
      '你的最终答复必须以这行信封开头（原样），然后才是你的完整回答：',
      `[fanout:${id}] [model:${model}] [question:${summary}]`,
    ].join('\n')
  }

  const fanoutNotify = (parent: Agent, work: WorkItem, fanModels: readonly string[], opts: DispatchOptions): FanoutTicket => {
    fanoutSeq += 1
    const id = `fanout-${fanoutSeq}`
    const controller = new AbortController()
    fanouts.set(id, { controller, models: [...fanModels], dropped: false })
    withParent(parent, () => {
      for (const model of fanModels) {
        channel.delegate(
          { ...work, prompt: envelope(work.prompt, id, model) },
          { ...opts, model, background: true, signal: controller.signal },
        )
      }
    })
    return { id, models: [...fanModels] }
  }

  const fanoutDrop = (id: string): boolean => {
    const entry = fanouts.get(id)
    if (entry === undefined || entry.dropped) return false
    entry.dropped = true
    entry.controller.abort()
    return true
  }

  const fanout = async (parent: Agent, work: WorkItem, fanModels: readonly string[], opts: DispatchOptions): Promise<Array<Report & { model: string }>> => {
    const timeoutMs = opts.timeoutMs ?? 8 * 60_000
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await withParent(parent, async () => {
        const entries = fanModels.map(model => {
          const result = channel.delegate(
            { ...work, prompt: envelope(work.prompt, 'collect', model) },
            { ...opts, model, background: false, signal: controller.signal },
          )
          return { model, report: result.report }
        })
        // 逐路安全阀：单路超时返回 [timeout] 占位，不拖垮整体。
        return await Promise.all(entries.map(async ({ model, report }) => {
          const settled = await Promise.race([
            report,
            new Promise<Report>(resolve => setTimeout(() => resolve({ status: 'failed', text: '[timeout]' }), timeoutMs + 5_000)),
          ])
          return { ...settled, model }
        }))
      })
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    delegate(parent, work, opts = {}) {
      return withParent(parent, () => channel.delegate(work, opts))
    },
    fanout,
    fanoutNotify,
    fanoutDrop,
    listModels: () => channel.listModels(),
    async continue(parent, childId, message) {
      await ctx.subagents.sendMessage(
        parent,
        childId as never,
        [{ type: 'text', text: message }] as ContentBlock[],
        { signal: new AbortController().signal } as never,
      )
    },
    ledger: {
      record(model, dimension, key, win) {
        modelLedger.record(model, dimension, key, win)
        onLedgerChange()
      },
      rank: (dimension, key, candidates, priceOrder) => modelLedger.rank(dimension, key, candidates, priceOrder),
      summary: () => modelLedger.summary(),
    },
  }
}
