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
import { ModelLedger, type ModelLedgerData } from './model-ledger.ts'
import { createJisiService } from './service.ts'
import { attachUsageMeter } from './usage-meter.ts'

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
  /** 能力账本种子路径（F33 ①）：本进程首次启动（运行账本不存在）时以此为基线。
   * 默认 $DSH_HOME/storages/jisi-model-ledger.seed.json。种子只允许 execution 维度
   * （规则 6 审计豁免：镜像内禁带 idea 维度/组织画像），加载时强制过滤。 */
  seedLedgerPath?: string
  /** 模型价格序（便宜→贵，同分经济性 tiebreak）。 */
  priceOrder?: string[]
  /** 单价表（每 1M token 的 CNY）。input=输入缓存未命中价；cacheRead=缓存命中价（缺省按 input）；output=输出价；
   * reasoning 缺省按 output 计；idle=空闲时段价（DeepSeek 夜间/周末半价，缺省同 input/output/cacheRead）。 */
  priceTable?: Record<string, { input: number; output: number; reasoning?: number; cacheRead?: number; idle?: { input: number; output: number; cacheRead?: number } }>
  /** 临时停用模型清单（如 2026-09-10 DeepSeek 官方把 v4-pro 全量路由至 4.1-flash 后暂停 pro）：
   * listModels/fanout 缺省/能力账本摘要一律不出现；显式派单响亮失败 [model-disabled]。 */
  disabledModels?: string[]
}

export function apply(ctx: Context, config: Config = {}): void {
  const provider = config.provider ?? 'spawn'
  const ledgerPath = config.ledgerPath ?? join(process.env.DSH_HOME ?? '.', 'storages', 'jisi-model-ledger.json')
  const disabledModels = new Set(config.disabledModels ?? [])
  const priceOrder = config.priceOrder ?? ['glm-5.3-flash', 'glm-4.5-air', 'glm-4.6', 'glm-4.7', 'deepseek-v4-flash', 'deepseek-flash', 'kimi-k2.6', 'kimi-k2.7-code', 'glm-5.3', 'kimi-k2.7-code-highspeed', 'kimi-k3']
  const priceTable = config.priceTable ?? {
    // 单价（CNY / 1M token）。2026-09-11 按官方定价页再校准：
    //  - Kimi：platform.kimi.com/docs/pricing/{chat-k3,chat-k27-code,chat-k26}
    //  - DeepSeek：api-docs.deepseek.com/zh-cn/quick_start/pricing/（峰/谷双价，谷=半价；高峰=周一至五 9-12/14-18）
    //  - GLM：官方价页 docs.bigmodel.cn/cn/guide/start/pricing（2026-09-12 会话登录抓取校准）。
    //    实测对账（run 11）：账本 GLM 侧 ≈2.4× 高估实扣（同 Kimi ≈2.5×），疑 reasoning 计入口径，
    //    暂不改公式，待用量明细核对（junji L4-RUN17497-live）。
    // 2026-09-11 DeepSeek 调价：flash 系列统一由 DeepSeek-V4.1-Flash 服务，新价 入1-2/出4-8/缓0.02-0.04（谷/峰）；
    // 旧名 deepseek-v4-flash / deepseek-v4-flash-vision-exp 仍可调用但已下线（按 Flash 价结算）；
    // 新官方名 deepseek-flash。v4-pro 09-14 退役计划已撤销（官方 09-12），继续原价服务。
    'deepseek-v4-flash': { input: 2, output: 8, cacheRead: 0.04, idle: { input: 1, output: 4, cacheRead: 0.02 } },
    'deepseek-flash': { input: 2, output: 8, cacheRead: 0.04, idle: { input: 1, output: 4, cacheRead: 0.02 } },
    // 2026-09-12 官方更新：撤销 09-14 退役计划——V4 Pro 继续原价服务（入4.5-9/出13.5-27）。
    // pro 仍 disabledModels 停用（我方决策：flash 单模满分已验证，花费纪律）；解禁与否由用户裁定。
    // pro 已 disabledModels 停用；重启用前必须按新结算价改本行（09-14 后 = flash 价）。
    'deepseek-v4-pro': { input: 9, output: 27, cacheRead: 0.3, idle: { input: 4.5, output: 13.5, cacheRead: 0.15 } },
    // vision-exp 已下线（09-11 /models 不再列出），请求由 V4.1-Flash 服务按 Flash 价；保留条目仅供历史账计价。
    'deepseek-v4-flash-vision-exp': { input: 2, output: 8, cacheRead: 0.04, idle: { input: 1, output: 4, cacheRead: 0.02 } },
    'kimi-k3': { input: 20, output: 100, cacheRead: 2 },
    'kimi-k2.6': { input: 6.5, output: 27, cacheRead: 1.1 },
    'kimi-k2.7-code': { input: 6.5, output: 27, cacheRead: 1.3 },
    'kimi-k2.7-code-highspeed': { input: 13, output: 54, cacheRead: 2.6 },
    'glm-5.3': { input: 8, output: 28, cacheRead: 2 },      // 官方 2026-09-12：8/28/缓存命中2（原 2.3 误记，更）
    'glm-5.3-flash': { input: 0.8, output: 2.8, cacheRead: 0.23 }, // 官方 2026-09-12：0.8/2.8/0.23 ✓（ESTIMATE 升格）
    'glm-4.7': { input: 4, output: 16, cacheRead: 0.8 },    // 官方阶梯（取最高档保守）：2/8/0.4(出<0.2K)、3/14/0.6(出≥0.2K)、4/16/0.8(入≥32K)
    'glm-4.6': { input: 1, output: 4 },          // 文本版已从官方价页移除（仅 4.6V/私有部署在售）；ESTIMATE 保留待实扣校准
    'glm-4.5-air': { input: 1.2, output: 8, cacheRead: 0.24 }, // 官方阶梯（取最高档保守）：0.8/2/0.16、0.8/6/0.16、1.2/8/0.24(入≥32K)
  }

  // 能力账本：本地落盘，跨 run 积累。
  // F33 ① 种子：运行账本不存在时以镜像种子为基线（选模型有据，不再冷启动 0.5 平权）。
  // 种子只保留 execution 维度——加载即过滤，任何 idea/org 维度即使混入镜像也不生效（规则 6 审计）。
  const seedLedgerPath = config.seedLedgerPath ?? join(process.env.DSH_HOME ?? '.', 'storages', 'jisi-model-ledger.seed.json')
  let ledger = new ModelLedger()
  let seeded = false
  try {
    if (existsSync(ledgerPath)) {
      ledger = ModelLedger.fromJSON(JSON.parse(readFileSync(ledgerPath, 'utf8')))
    } else if (existsSync(seedLedgerPath)) {
      const raw = JSON.parse(readFileSync(seedLedgerPath, 'utf8')) as ModelLedgerData | undefined
      const executionOnly: ModelLedgerData = { models: {} }
      for (const [model, m] of Object.entries(raw?.models ?? {})) {
        const exec = m?.dimensions?.execution
        if (exec === undefined) continue
        executionOnly.models[model] = { dimensions: { execution: exec } }
      }
      ledger = ModelLedger.fromJSON(executionOnly)
      seeded = true
    }
  } catch { /* 账本/种子损坏：空账本起跑 */ }
  const persistLedger = (): void => {
    try {
      mkdirSync(join(ledgerPath, '..'), { recursive: true })
      writeFileSync(ledgerPath, JSON.stringify(ledger.toJSON()))
    } catch { /* 落盘失败不致命 */ }
  }
  // 种子基线立即落盘成运行账本：重启/新进程都从"种子+本 run 战绩"续跑。
  if (seeded) persistLedger()

  ctx.provide('jisi', createJisiService(ctx, provider, ledger, persistLedger, disabledModels))

  // 用量计量器（provider 无关）：主 agent 与全部子代理、任何 provider 路由的每次
  // LLM 调用都进 sidecar（F9 根治；compat 适配器不再自行写入，避免双计）。
  attachUsageMeter(ctx)

  // 工具 1：fanout —— 任意 agent 随时调用；notify 缺省（先完成先到，不等慢模型）。
  ctx.tools.register(defineTool({
    name: 'jisi_fanout',
    description:
      'Fan a prompt out to multiple models in parallel and get their raw reports, unsynthesized. ANY agent may call this at any time — especially when stuck on a hard problem and wanting diverse approaches or fresh ideas. Default mode=notify returns immediately (each model reports independently as it finishes — the slowest never blocks you); mode=collect blocks until timeoutMinutes and returns the settled subset. Every report carries an envelope line [fanout:<id>] [model] [question] so results from multiple fanouts never get mixed up. Use jisi_fanout_drop to stop the remaining thinking once the question is answered (saves tokens).',
    parameters: {
      prompt: { type: 'string', required: true, description: 'The self-contained work/idea prompt sent to every model.' },
      models: { type: 'array', description: 'Model ids to fan out to. Default: the registered model list.' },
      effort: { type: 'string', description: 'Reasoning effort (off/low/high/max) where supported; unsupported efforts are dropped per model.' },
      mode: { type: 'string', description: 'notify (default: return immediately, reports arrive independently) | collect (block for the settled subset).' },
      timeoutMinutes: { type: 'number', description: 'collect mode timeout in minutes (default 8).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    async execute(args: { prompt: string; models?: string[]; effort?: string; mode?: string; timeoutMinutes?: number }, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('jisi_fanout requires a calling agent')
      const models = args.models ?? (await ctx.jisi.listModels()).map(m => m.id)
      if (models.length === 0) return 'jisi_fanout: no models registered'
      const opts = {
        ...(args.effort !== undefined ? { reasoningEffort: args.effort } : {}),
        ...(args.timeoutMinutes !== undefined ? { timeoutMs: args.timeoutMinutes * 60_000 } : {}),
      }
      if (args.mode === 'collect') {
        const reports = await ctx.jisi.fanout(agent, { prompt: args.prompt }, models, opts)
        return reports.map(r => `[${r.model}] ${r.status}: ${r.text.trim()}`).join('\n\n')
      }
      const ticket = ctx.jisi.fanoutNotify(agent, { prompt: args.prompt }, models, opts)
      return `[fanout:${ticket.id}] dispatched to ${ticket.models.length} model(s) in notify mode: ${ticket.models.join(', ')}.\n` +
        `Each model reports independently as it settles (fastest first) with the envelope [fanout:${ticket.id}] [model] [question]; wait for the reports instead of re-asking. Once the question is answered, call jisi_fanout_drop with id ${ticket.id} to stop the remaining thinking and save tokens.`
    },
  }))

  // 工具 1c：fanout bulk —— F31：一次调用扇出全部征思路任务（托管网关 20s/轮
  // 的链路税被摊薄到整批），发兵不再受主 agent 回合循环速度限制。
  ctx.tools.register(defineTool({
    name: 'jisi_fanout_bulk',
    description:
      'Bulk fanout (F31): one tool call spawns idea-collection delegates for MANY prompts × models at once. This is THE way to run the opening idea sweep in hosted mode — each main-agent round-trip costs ~20s through the platform gateway, so issue the whole sweep in one call instead of one fanout per round. Returns immediately (notify semantics): every report arrives independently with its [fanout:<id>] [model] [question] envelope.',
    parameters: {
      specs: { type: 'array', required: true, description: 'Fanout specs: [{prompt (required), models? (default all), effort?}]' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => true,
    async execute(args: { specs?: Array<{ prompt: string; models?: string[]; effort?: string }> }, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('jisi_fanout_bulk requires a calling agent')
      const specs = args.specs ?? []
      if (specs.length === 0) return 'jisi_fanout_bulk: empty specs'
      const allIds = (await ctx.jisi.listModels()).map(m => m.id)
      // 安全上限：单次批量最多 400 路 delegate（40 题 × 10 模型量级）。
      let totalDelegates = 0
      const spawned: string[] = []
      for (const spec of specs) {
        const models = (spec.models && spec.models.length > 0 ? spec.models : allIds)
        if (totalDelegates + models.length > 400) break
        const opts = { ...(spec.effort !== undefined ? { reasoningEffort: spec.effort } : {}) }
        const ticket = ctx.jisi.fanoutNotify(agent, { prompt: spec.prompt }, models, opts)
        totalDelegates += ticket.models.length
        spawned.push(ticket.id)
      }
      return `jisi_fanout_bulk: ${spawned.length} fanouts spawned (${totalDelegates} model delegates total), ids: ${spawned.join(', ')}.\nReports arrive independently with [fanout:<id>] [model] [question] envelopes; wait for them (xiaochang_wait wakes on their arrival) and call jisi_fanout_drop <id> once a question is answered.`
    },
  }))

  // 工具 1b：fanout drop —— 问题已解，停掉剩余思考。
  ctx.tools.register(defineTool({
    name: 'jisi_fanout_drop',
    description:
      'Stop a fanout that is no longer needed: aborts all not-yet-settled model runs (stops their token spend) and marks the ticket dropped — late reports, if any, should be ignored by their [fanout:<id>] envelope. Call this as soon as the question the fanout was asking is answered.',
    parameters: {
      id: { type: 'string', required: true, description: 'The fanout id from jisi_fanout (notify mode) return.' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => true,
    async execute(args: { id: string }) {
      const dropped = ctx.jisi.fanoutDrop(args.id)
      return dropped
        ? `fanout ${args.id} dropped: unsettled runs aborted; ignore any late reports carrying this id.`
        : `fanout ${args.id}: unknown id or already dropped`
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
      const summary = ctx.jisi.ledger.summary().filter(s => !disabledModels.has(s.model))
      if (summary.length === 0) return 'jisi_model_report: ledger is empty (cold start — all candidates equal, cheapest wins)'
      return summary.map(s => `${s.dimension}/${s.key} ${s.model}: ${s.wins}/${s.attempts} (rate ${s.rate.toFixed(2)})`).join('\n')
    },
  }))

  // 工具 3：花费计量 —— 主 agent 每轮先看账再派兵。
  ctx.tools.register(defineTool({
    name: 'jisi_usage',
    description:
      'Aggregate per-model token usage and cost (CNY) from the local usage sidecar (the usage meter records every LLM call of every provider and every agent — main and subagents alike). Kimi/DeepSeek prices are calibrated from official pricing pages (2026-09-08); DeepSeek costs respect peak vs off-peak hours (nights/weekends are half price); cache-hit tokens are priced at the cache-hit rate. GLM entries are still estimates. Use it every round to keep spend in check.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => true,
    async execute() {
      const sidecar = join(process.env.DSH_HOME ?? '.', 'storages', 'llm-usage.jsonl')
      const totals = new Map<string, { calls: number; input: number; output: number; reasoning: number; cacheRead: number; cost: number }>()
      // 去重：meter 行带 (sid, seq)（会话 id + 事件序号）；会话重载/进程重启重放会产生
      // 重复行，按 (sid, seq) 去重。旧 compat 行无 sid → 不参与去重（原样计入）。
      const seen = new Set<string>()
      try {
        if (existsSync(sidecar)) {
          for (const line of readFileSync(sidecar, 'utf8').split('\n')) {
            if (line.trim() === '') continue
            const record = JSON.parse(line) as { provider?: string; model?: string; inputTokens?: number; outputTokens?: number; reasoningTokens?: number; cacheReadTokens?: number; at?: number; sid?: string; seq?: number }
            if (record.sid !== undefined && record.seq !== undefined) {
              const dedupeKey = `${record.sid}#${record.seq}`
              if (seen.has(dedupeKey)) continue
              seen.add(dedupeKey)
            }
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
              // 2026-09-12 实测（run 11 对账 + 裸调探针）：
              //  ① outputTokens = completion_tokens 已含 reasoning（DS/Kimi/GLM 三探针均证），
              //    reasoningTokens 只是其子集——旧公式再乘一次 reasoning 价 = 双重计价，已删；
              //  ② Kimi/GLM 侧曾被 compat 旧 lib 重复写行（无 sid/seq 不参与去重）→ 已由
              //    source 修复 + profile 重装解决（见 junji L4-RUN17497-live）。
              t.cost += (ri * p.input + rc * hit + ro * p.output) / 1_000_000
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
