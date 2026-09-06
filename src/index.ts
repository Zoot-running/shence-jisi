/**
 * 集思 DSH 插件入口：绑定宿主能力并暴露 ctx.jisi 服务 + 三个工具。
 * 工具：jisi_fanout（任意 agent 随时调用，交付即结束）、jisi_model_report（能力账本摘要）、
 * jisi_record（人工判断一句话回记：思路对错/执行质量）。
 * 模型能力账本：越用越了解各模型（execution/idea 双维度），本地落盘跨 run 积累。
 * @module @shence/jisi
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ModelLedger } from './model-ledger.ts'
import { createJisiService } from './service.ts'

export const name = 'shence-jisi'
export const inject = ['subagents', 'llm', 'tools']

export interface Config {
  /** ctx.subagents 的 provider 名（默认 spawn）。 */
  provider?: string
  /** 模型能力账本路径（默认 $DSH_HOME/storages/jisi-model-ledger.json）。 */
  ledgerPath?: string
  /** 模型价格序（便宜→贵，同分经济性 tiebreak）。 */
  priceOrder?: string[]
  /** 单价表（每 1M token 的 CNY；input/output/reasoning 缺省按 output 计）。估算值，登录平台账单后校准。 */
  priceTable?: Record<string, { input: number; output: number; reasoning?: number }>
}

export function apply(ctx: Context, config: Config = {}): void {
  const provider = config.provider ?? 'spawn'
  const ledgerPath = config.ledgerPath ?? join(process.env.DSH_HOME ?? '.', 'storages', 'jisi-model-ledger.json')
  const priceOrder = config.priceOrder ?? ['deepseek-v4-flash', 'glm-5.3-flash', 'kimi-k3', 'glm-5.3', 'deepseek-v4-pro']
  const priceTable = config.priceTable ?? {
    // 估算单价（CNY / 1M token）——登录平台账单后校准。
    'deepseek-v4-flash': { input: 2, output: 6 },
    'deepseek-v4-pro': { input: 4, output: 16 },
    'kimi-k3': { input: 8, output: 32 },  // 观察到的实际消耗偏高：估算上修，待平台账单校准
    'kimi-k2.6': { input: 1, output: 3 },
    'glm-5.3': { input: 1, output: 4 },
    'glm-5.3-flash': { input: 0.5, output: 2 },
    'glm-4.6': { input: 1, output: 4 },
    'glm-4.5-air': { input: 0.5, output: 1 },
  }

  // 能力账本：本地落盘，跨 run 积累。
  let ledger = new ModelLedger()
  try {
    if (existsSync(ledgerPath)) ledger = ModelLedger.fromJSON(JSON.parse(readFileSync(ledgerPath, 'utf8')))
  } catch { /* 账本损坏：空账本起跑 */ }
  const persistLedger = (): void => {
    try {
      mkdirSync(join(ledgerPath, '..'), { recursive: true })
      writeFileSync(ledgerPath, JSON.stringify(ledger.toJSON()))
    } catch { /* 落盘失败不致命 */ }
  }

  ctx.provide('jisi', createJisiService(ctx, provider, ledger, persistLedger))

  // 工具 1：fanout —— 任意 agent 随时调用；交付即结束，不做综合。
  ctx.tools.register(defineTool({
    name: 'jisi_fanout',
    description:
      'Fan a prompt out to multiple models in parallel and return their raw reports, unsynthesized. ANY agent may call this at any time — especially when stuck on a hard problem and wanting diverse approaches or fresh ideas. The models are released once they answer; you decide when to call, how many models, and how many ideas to ask for (nothing is forced).',
    parameters: {
      prompt: { type: 'string', required: true, description: 'The self-contained work/idea prompt sent to every model.' },
      models: { type: 'array', description: 'Model ids to fan out to. Default: the registered model list.' },
      effort: { type: 'string', description: 'Reasoning effort (off/low/high/max) where supported; unsupported efforts are dropped per model.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    async execute(args: { prompt: string; models?: string[]; effort?: string }, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('jisi_fanout requires a calling agent')
      const models = args.models ?? (await ctx.jisi.listModels()).map(m => m.id)
      if (models.length === 0) return 'jisi_fanout: no models registered'
      const reports = await ctx.jisi.fanout(agent, { prompt: args.prompt }, models, {
        background: false,
        ...(args.effort !== undefined ? { reasoningEffort: args.effort } : {}),
      })
      return reports.map((r, i) => `[${models[i]}] ${r.status}: ${r.text.trim()}`).join('\n\n')
    },
  }))

  // 工具 2：能力账本摘要 —— 主 agent 派单决策的依据。
  ctx.tools.register(defineTool({
    name: 'jisi_model_report',
    description:
      'Report the model capability ledger: per (model, dimension, key) attempts/wins/smoothed rate. Use it to assign the most suitable executor or idea-giver; rates learn over time (Laplace-smoothed, price tiebreak on ties).',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    async execute() {
      const summary = ctx.jisi.ledger.summary()
      if (summary.length === 0) return 'jisi_model_report: ledger is empty (cold start — all candidates equal, cheapest wins)'
      return summary.map(s => `${s.dimension}/${s.key} ${s.model}: ${s.wins}/${s.attempts} (rate ${s.rate.toFixed(2)})`).join('\n')
    },
  }))

  // 工具 3：花费计量 —— 主 agent 每轮先看账再派兵。
  ctx.tools.register(defineTool({
    name: 'jisi_usage',
    description:
      'Aggregate per-model token usage and ESTIMATED cost (CNY) from the local usage sidecar (llm-openai-compat writes every call). Prices are estimates until calibrated against the provider billing dashboards. Use it every round to keep spend in check and downgrade expensive models.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => true,
    async execute() {
      const sidecar = join(process.env.DSH_HOME ?? '.', 'storages', 'llm-usage.jsonl')
      const totals = new Map<string, { calls: number; input: number; output: number; reasoning: number; cacheRead: number }>()
      try {
        if (existsSync(sidecar)) {
          for (const line of readFileSync(sidecar, 'utf8').split('\n')) {
            if (line.trim() === '') continue
            const record = JSON.parse(line) as { provider?: string; model?: string; inputTokens?: number; outputTokens?: number; reasoningTokens?: number; cacheReadTokens?: number }
            const key = `${record.provider ?? '?'}/${record.model ?? '?'}`
            const t = totals.get(key) ?? { calls: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0 }
            t.calls += 1
            t.input += record.inputTokens ?? 0
            t.output += record.outputTokens ?? 0
            t.reasoning += record.reasoningTokens ?? 0
            t.cacheRead += record.cacheReadTokens ?? 0
            totals.set(key, t)
          }
        }
      } catch { /* sidecar 不存在/坏行 */ }
      if (totals.size === 0) return 'jisi_usage: no usage recorded yet (sidecar empty)'
      const rows: string[] = []
      let grand = 0
      for (const [key, t] of [...totals.entries()].sort((a, b) => b[1].input + b[1].output - a[1].input - a[1].output)) {
        const model = key.split('/')[1] ?? '?'
        const price = priceTable[model] ?? { input: 0, output: 0 }
        const cost = ((t.input * price.input + t.output * price.output + t.reasoning * (price.reasoning ?? price.output)) / 1_000_000)
        grand += cost
        rows.push(`${key}: ${t.calls} calls, in=${t.input} out=${t.output} reasoning=${t.reasoning} cacheRead=${t.cacheRead} → ~¥${cost.toFixed(2)}${priceTable[model] === undefined ? ' (no price, uncounted)' : ''}`)
      }
      rows.push(`TOTAL estimated: ~¥${grand.toFixed(2)} (price table is an ESTIMATE — calibrate after platform login)`)
      return rows.join('\n')
    },
  }))

  // 工具 4：人工判断回记 —— 思路对错/执行质量一句话入账。
  ctx.tools.register(defineTool({
    name: 'jisi_record',
    description:
      'Record one model-ability judgment: execution outcome (dimension=execution, key=difficulty, win=solved) or idea quality (dimension=idea, key=freeform category, win=adopted/verified). The ledger learns from every record.',
    parameters: {
      model: { type: 'string', required: true, description: 'Model id being rated.' },
      dimension: { type: 'string', required: true, description: 'execution | idea.' },
      key: { type: 'string', required: true, description: 'Dimension key (e.g. difficulty for execution, challenge/category for idea).' },
      win: { type: 'boolean', required: true, description: 'true = solved/adopted/verified; false = failed/dead-end.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    async execute(args: { model: string; dimension: string; key: string; win: boolean }) {
      if (args.dimension !== 'execution' && args.dimension !== 'idea') return 'jisi_record: dimension must be execution | idea'
      ctx.jisi.ledger.record(args.model, args.dimension, args.key, args.win)
      return `recorded: ${args.model} ${args.dimension}/${args.key} ${args.win ? 'win' : 'loss'}`
    },
  }))
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    jisi: import('./service.ts').JisiService
  }
}
