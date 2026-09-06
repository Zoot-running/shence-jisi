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
}

export function apply(ctx: Context, config: Config = {}): void {
  const provider = config.provider ?? 'spawn'
  const ledgerPath = config.ledgerPath ?? join(process.env.DSH_HOME ?? '.', 'storages', 'jisi-model-ledger.json')
  const priceOrder = config.priceOrder ?? ['deepseek-v4-flash', 'glm-5.3-flash', 'kimi-k3', 'glm-5.3', 'deepseek-v4-pro']

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
      'Fan a prompt out to multiple models in parallel and return their raw reports, unsynthesized. Call whenever you need diverse approaches; you decide how many models and how many ideas to ask for (say it in the prompt). The models are released once they answer.',
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

  // 工具 3：人工判断回记 —— 思路对错/执行质量一句话入账。
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
