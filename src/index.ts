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

/**
 * DeepSeek 高峰时段判定（北京时间周一至周五 9:00-12:00、14:00-18:00）。
 * 其余时段（夜间/周末）为半价空闲时段。无时间戳时按当前时间判。
 * @param at - 调用时间戳 ms（sidecar 的 `at` 字段），缺省用当前时间。
 */
export function isBeijingPeak(at?: number): boolean {
  const d = new Date(at ?? Date.now())
  const beijing = new Date(d.getTime() + 8 * 3600_000)
  const day = beijing.getUTCDay() // 0=周日 … 6=周六
  if (day === 0 || day === 6) return false
  const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes()
  return (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60)
}

export interface Config {
  /** ctx.subagents 的 provider 名（默认 spawn）。 */
  provider?: string
  /** 模型能力账本路径（默认 $DSH_HOME/storages/jisi-model-ledger.json）。 */
  ledgerPath?: string
  /** 模型价格序（便宜→贵，同分经济性 tiebreak）。 */
  priceOrder?: string[]
  /** 单价表（每 1M token 的 CNY）。input=输入缓存未命中价；cacheRead=缓存命中价（缺省按 input）；output=输出价；
   * reasoning 缺省按 output 计；idle=空闲时段价（DeepSeek 夜间/周末半价，缺省同 input/output/cacheRead）。 */
  priceTable?: Record<string, { input: number; output: number; reasoning?: number; cacheRead?: number; idle?: { input: number; output: number; cacheRead?: number } }>
}

export function apply(ctx: Context, config: Config = {}): void {
  const provider = config.provider ?? 'spawn'
  const ledgerPath = config.ledgerPath ?? join(process.env.DSH_HOME ?? '.', 'storages', 'jisi-model-ledger.json')
  const priceOrder = config.priceOrder ?? ['glm-4.5-air', 'glm-5.3-flash', 'glm-4.6', 'deepseek-v4-flash', 'kimi-k2.6', 'kimi-k2.7-code', 'deepseek-v4-pro', 'glm-5.3', 'kimi-k2.7-code-highspeed', 'kimi-k3']
  const priceTable = config.priceTable ?? {
    // 单价（CNY / 1M token）。2026-09-08 按官方定价页校准：
    //  - Kimi：platform.kimi.com/docs/pricing/{chat-k3,chat-k27-code,chat-k26}
    //  - DeepSeek：api-docs.deepseek.com/zh-cn/quick_start/pricing/（峰/谷双价，谷=半价；高峰=周一至五 9-12/14-18）
    //  - GLM：仍为估算（待智谱平台价格页核对，见 shence-junji VALIDATION/L2-MODEL-CATALOG-2026-09.md）
    'deepseek-v4-flash': { input: 3, output: 9, cacheRead: 0.1, idle: { input: 1.5, output: 4.5, cacheRead: 0.05 } },
    'deepseek-v4-pro': { input: 9, output: 27, cacheRead: 0.3, idle: { input: 4.5, output: 13.5, cacheRead: 0.15 } },
    'deepseek-v4-flash-vision-exp': { input: 3, output: 9, cacheRead: 0.1, idle: { input: 1.5, output: 4.5, cacheRead: 0.05 } },
    'kimi-k3': { input: 20, output: 100, cacheRead: 2 },
    'kimi-k2.6': { input: 6.5, output: 27, cacheRead: 1.1 },
    'kimi-k2.7-code': { input: 6.5, output: 27, cacheRead: 1.3 },
    'kimi-k2.7-code-highspeed': { input: 13, output: 54, cacheRead: 2.6 },
    'glm-5.3': { input: 10, output: 31 },        // ESTIMATE（$1.4/$4.4 国际价≈¥10/¥31），待智谱校准
    'glm-5.3-flash': { input: 1, output: 2 },    // ESTIMATE，待智谱校准
    'glm-4.6': { input: 1, output: 4 },          // ESTIMATE，待智谱校准
    'glm-4.5-air': { input: 0.5, output: 1 },    // ESTIMATE，待智谱校准
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
      'Aggregate per-model token usage and cost (CNY) from the local usage sidecar (llm-openai-compat writes every call). Kimi/DeepSeek prices are calibrated from official pricing pages (2026-09-08); DeepSeek costs respect peak vs off-peak hours (nights/weekends are half price); cache-hit tokens are priced at the cache-hit rate. GLM entries are still estimates. Use it every round to keep spend in check.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => true,
    async execute() {
      const sidecar = join(process.env.DSH_HOME ?? '.', 'storages', 'llm-usage.jsonl')
      const totals = new Map<string, { calls: number; input: number; output: number; reasoning: number; cacheRead: number; cost: number }>()
      try {
        if (existsSync(sidecar)) {
          for (const line of readFileSync(sidecar, 'utf8').split('\n')) {
            if (line.trim() === '') continue
            const record = JSON.parse(line) as { provider?: string; model?: string; inputTokens?: number; outputTokens?: number; reasoningTokens?: number; cacheReadTokens?: number; at?: number }
            const key = `${record.provider ?? '?'}/${record.model ?? '?'}`
            const t = totals.get(key) ?? { calls: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cost: 0 }
            t.calls += 1
            const model = record.model ?? '?'
            const ri = record.inputTokens ?? 0
            const ro = record.outputTokens ?? 0
            const rr = record.reasoningTokens ?? 0
            const rc = record.cacheReadTokens ?? 0
            t.input += ri
            t.output += ro
            t.reasoning += rr
            t.cacheRead += rc
            const price = priceTable[model]
            if (price !== undefined) {
              // 峰/谷计价：DeepSeek 高峰=北京时间周一至五 9:00-12:00、14:00-18:00，其余半价。
              const p = isBeijingPeak(record.at) ? price : (price.idle ?? price)
              const hit = p.cacheRead ?? p.input
              t.cost += (ri * p.input + rc * hit + ro * p.output + rr * (p.reasoning ?? p.output)) / 1_000_000
            }
            totals.set(key, t)
          }
        }
      } catch { /* sidecar 不存在/坏行 */ }
      if (totals.size === 0) return 'jisi_usage: no usage recorded yet (sidecar empty)'
      const rows: string[] = []
      let grand = 0
      for (const [key, t] of [...totals.entries()].sort((a, b) => b[1].input + b[1].output - a[1].input - a[1].output)) {
        const model = key.split('/')[1] ?? '?'
        grand += t.cost
        rows.push(`${key}: ${t.calls} calls, in=${t.input} out=${t.output} reasoning=${t.reasoning} cacheRead=${t.cacheRead} → ~¥${t.cost.toFixed(2)}${priceTable[model] === undefined ? ' (no price, uncounted)' : ''}`)
      }
      rows.push(`TOTAL estimated: ~¥${grand.toFixed(2)} (Kimi/DeepSeek calibrated 2026-09-08; GLM entries are estimates)`)
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
