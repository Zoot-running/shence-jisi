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
import { ModelLedgerV2, QUESTION_TYPES, difficultyBucket, type Attribution, type Dimension, type QuestionType, type RankEntry } from './model-ledger-v2.ts'
import { calibratedDifficulty, difficultyState, observeDifficulty, priorFromScore } from './difficulty.ts'
import { priorsFor } from './benchmark-priors.ts'
import { failWeight, winWeight } from './score.ts'
import { readBalanceExhausted } from '@shence/dsh-compat'
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
  /** fanout 缺省模型档（F34, run 17923 账单实锤）：未显式给 models 时只扇这些——
   * 缺省 flash 系(vision-exp 是 V4.1-Flash 的退役别名, 去掉防视觉名误导)。
   * 智谱钱包 2026-09-13 归零(充值400/已花400)、kimi 贵——都只显式才上。
   * 这不是限制——agent 想多视角随时可显式 models；是修掉"没指定=全模型"的危险兜底。 */
  fanoutDefaultModels?: string[]
  /** v2 取数策略(JISI-V2-DESIGN 2.4): fanout 缺省按 pick 排名取 top-fraction(默认 0.5=目录上半)。 */
  fanoutSelection?: { strategy?: 'top-fraction' | 'top-n' | 'all'; fraction?: number; n?: number; min?: number; max?: number }
  /** v2 账本: 三层收缩强度 / 改名继承 / 退役作废(JISI-V2-DESIGN 第 1 层)。 */
  shrinkageStrength?: number
  modelAliases?: Record<string, string>
  voidModels?: string[]
  /** 对数权重旋钮(第 0 层, 默认 1)。 */
  kW?: number
  kF?: number
}

export function apply(ctx: Context, config: Config = {}): void {
  const provider = config.provider ?? 'spawn'
  const ledgerPath = config.ledgerPath ?? join(process.env.DSH_HOME ?? '.', 'storages', 'jisi-model-ledger.json')
  const disabledModels = new Set(config.disabledModels ?? [])
  const fanoutDefaultModels = config.fanoutDefaultModels ?? ['deepseek-v4-flash', 'deepseek-flash', 'glm-5.3-flash']
  // F35 余额枯竭隔离: 每次调用重读 sidecar(跨会话由盘文件同步, 与分叉信箱同机制)。
  const exhaustedProviders = (): Set<string> => new Set(readBalanceExhausted().map(r => r.provider))
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
  // ── v2 决策内核账本(第 1 层) ──
  const ledgerV2Path = join(process.env.DSH_HOME ?? '.', 'storages', 'jisi-model-ledger-v2.json')
  let ledgerV2 = new ModelLedgerV2({
    shrinkageStrength: config.shrinkageStrength ?? 5,
    modelAliases: config.modelAliases ?? {},
    voidModels: config.voidModels ?? [],
  })
  try {
    if (existsSync(ledgerV2Path)) ledgerV2 = ModelLedgerV2.fromJSON(JSON.parse(readFileSync(ledgerV2Path, 'utf8')), {
      shrinkageStrength: config.shrinkageStrength ?? 5,
      modelAliases: config.modelAliases ?? {},
      voidModels: config.voidModels ?? [],
    })
    else if (existsSync(ledgerPath)) {
      // 迁移: 旧账本 execution 记录折成 v2(题型 misc、权重 1、难度按 key)。
      const legacy = ModelLedger.fromJSON(JSON.parse(readFileSync(ledgerPath, 'utf8')))
      for (const row of legacy.summary()) {
        if (row.dimension !== 'execution') continue
        const diff = Number(row.key) || priorFromScore(300)
        for (let i = 0; i < row.attempts; i += 1) {
          ledgerV2.record({ model: row.model, dimension: 'execution', qtype: 'misc', difficulty: diff, weight: 1, win: i < row.wins, source: 'observation', note: 'migrated-legacy' })
        }
      }
    }
  } catch { /* v2 账本损坏: 空账本起跑 */ }
  const persistLedgerV2 = (): void => {
    try {
      mkdirSync(join(ledgerV2Path, '..'), { recursive: true })
      writeFileSync(ledgerV2Path, JSON.stringify(ledgerV2.toJSON()))
    } catch { /* 落盘失败不致命 */ }
  }
  // 采纳裁决登记: code → 采纳条目(终局对账用)。
  const adoptions = new Map<string, Array<{ reportId: string; model: string; difficulty: number; weight: number }>>()
  const kW = config.kW ?? 1
  const kF = config.kF ?? 1
  const sel = config.fanoutSelection ?? {}
  const fanoutSel = {
    strategy: sel.strategy ?? 'top-fraction',
    fraction: sel.fraction ?? 0.5,
    n: sel.n ?? 3,
    min: sel.min ?? 1,
    max: sel.max ?? 0,
  }
  const selectModels = (ranked: RankEntry[]): RankEntry[] => {
    let picked = ranked
    if (fanoutSel.strategy === 'top-n') picked = ranked.slice(0, fanoutSel.n)
    else if (fanoutSel.strategy === 'top-fraction') picked = ranked.slice(0, Math.max(fanoutSel.min, Math.round(ranked.length * fanoutSel.fraction)))
    if (fanoutSel.max > 0) picked = picked.slice(0, fanoutSel.max)
    return picked
  }
  // 种子基线立即落盘成运行账本：重启/新进程都从"种子+本 run 战绩"续跑。
  if (seeded) persistLedger()

  const jisiService = createJisiService(ctx, provider, ledger, persistLedger, disabledModels)
  // v2 决策内核 + F35 余额隔离查询(供 runner 复用)。
  ctx.provide('jisi', {
    ...jisiService,
    isModelQuarantined: async (model: string): Promise<boolean> => {
      try {
        const catalog = await jisiService.listModels()
        const info = catalog.find(m => m.id === model)
        return info !== undefined && exhaustedProviders().has(info.provider)
      } catch { return false }
    },
    /** v2 加权入账(第 0/1 层)。 */
    recordV2: (r: { model: string; dimension: Dimension; qtype: QuestionType; difficulty: number; weight: number; win: boolean; attribution?: Attribution; elapsedMin?: number; firstTry?: boolean; note?: string }): void => {
      ledgerV2.record({ ...r, source: 'observation' })
      persistLedgerV2()
    },
    /** 终局对账(采纳的思路): 胜不动; 败且 approach-dead-end → 罚思路模型。 */
    settleAdoptions: (code: string, win: boolean, attribution: Attribution | undefined): void => {
      const entries = adoptions.get(code) ?? []
      if (entries.length === 0) return
      adoptions.delete(code)
      if (win) return
      if (attribution !== 'approach-dead-end') return
      for (const e of entries) {
        ledgerV2.record({
          model: e.model, dimension: 'idea', qtype: 'misc', difficulty: e.difficulty,
          weight: failWeight(e.difficulty, kF), win: false, attribution, source: 'observation',
          note: `adopted report ${e.reportId} terminal loss`,
        })
      }
      persistLedgerV2()
    },
    ledgerV2: () => ledgerV2,
    /** 采纳裁决(第 0 层): adopted 即记 idea 正(对数权重)。 */
    adjudicate: (code: string, difficulty: number, verdicts: Array<{ reportId: string; verdict: 'adopted' | 'not-adopted' | 'pending'; note?: string; model: string }>): string => {
      const list = adoptions.get(code) ?? []
      let adopted = 0
      for (const v of verdicts) {
        if (v.verdict !== 'adopted') continue
        const w = winWeight(difficulty, kW)
        list.push({ reportId: v.reportId, model: v.model, difficulty, weight: w })
        ledgerV2.record({
          model: v.model, dimension: 'idea', qtype: 'misc', difficulty,
          weight: w, win: true, source: 'observation', note: `adopted ${v.reportId}`,
        })
        adopted += 1
      }
      if (list.length > 0) adoptions.set(code, list)
      persistLedgerV2()
      return `adjudicated: ${adopted} adopted (idea +w), ${verdicts.length - adopted} not-adopted/pending (no score). 终局对账: 题胜不加分; 题败且归因 approach-dead-end → 思路模型 −w_f.`
    },
  })

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
      models: { type: 'array', description: 'Model ids to fan out to. Default: v2 pick top-fraction (cheap-tier fallback when qtype/difficulty absent); others only when explicitly listed (F34).' },
      effort: { type: 'string', description: 'Reasoning effort (off/low/high/max) where supported; unsupported efforts are dropped per model.' },
      mode: { type: 'string', description: 'notify (default: return immediately, reports arrive independently) | collect (block for the settled subset).' },
      timeoutMinutes: { type: 'number', description: 'collect mode timeout in minutes (default 8).' },
      qtype: { type: 'string', description: 'v2: question type (web/crypto/pwn/rev/forensics/misc) for fit-based default selection.' },
      difficulty: { type: 'number', description: 'v2: calibrated difficulty 0-100 for fit-based default selection.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    async execute(args: { prompt: string; models?: string[]; effort?: string; mode?: string; timeoutMinutes?: number }, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('jisi_fanout requires a calling agent')
      // F35: 余额枯竭 provider 的模型自动隔离(缺省剔除; 显式派单响亮失败)。
      const catalog = await ctx.jisi.listModels()
      const exhausted = exhaustedProviders()
      const allCatalog = catalog.map(m => m.id)
      let models: string[]
      if (args.models !== undefined) {
        models = args.models
      } else if (args.qtype !== undefined && args.difficulty !== undefined && QUESTION_TYPES.includes(args.qtype as QuestionType)) {
        // v2: 缺省 = idea-fit 排名取 top-fraction(第 2 层), 先验=公开基准。
        const ranked = ledgerV2.rank('idea', args.qtype as QuestionType, args.difficulty, allCatalog, m => {
          const pr = priorsFor(m, 'idea', args.qtype as QuestionType)
          return { a: pr.a, b: pr.b }
        })
        const picked = selectModels(ranked)
        models = picked.map(r => r.model)
        if (models.length === 0) models = allCatalog.filter(m => fanoutDefaultModels.includes(m))
      } else {
        // 无题目特征: 便宜档兜底(F34)。
        models = allCatalog.filter(m => fanoutDefaultModels.includes(m))
      }
      const blocked = (args.models ?? []).filter(m => exhausted.has(catalog.find(c => c.id === m)?.provider ?? ''))
      if (blocked.length > 0) return `jisi_fanout: 拒绝显式派单 ${blocked.join(', ')}——该 provider 余额已枯竭(隔离中)。换模型; 并把"XX 余额不足"写进最终战报提示用户充值。`
      models = models.filter(m => !exhausted.has(catalog.find(c => c.id === m)?.provider ?? ''))
      if (models.length === 0) return 'jisi_fanout: no models registered (check 余额隔离)'
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
      specs: { type: 'array', required: true, description: 'Fanout specs: [{prompt (required), models? (default flash family only), effort?}]' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => true,
    async execute(args: { specs?: Array<{ prompt: string; models?: string[]; effort?: string }> }, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('jisi_fanout_bulk requires a calling agent')
      const specs = args.specs ?? []
      if (specs.length === 0) return 'jisi_fanout_bulk: empty specs'
      const catalog = await ctx.jisi.listModels()
      const allIds = catalog.map(m => m.id)
      // F35: 余额枯竭 provider 的模型自动隔离。
      const exhausted = exhaustedProviders()
      // F34: spec 未显式给 models → flash 系缺省(与 jisi_fanout 同档); 贵模型/glm 只显式才上。
      const defaultIds = allIds.filter(m => fanoutDefaultModels.includes(m) && !exhausted.has(catalog.find(c => c.id === m)?.provider ?? ''))
      // 安全上限：单次批量最多 400 路 delegate（40 题 × 10 模型量级）。
      let totalDelegates = 0
      const spawned: string[] = []
      for (const spec of specs) {
        const models = (spec.models && spec.models.length > 0 ? spec.models : defaultIds)
          .filter(m => !exhausted.has(catalog.find(c => c.id === m)?.provider ?? ''))
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
      const ex = [...exhaustedProviders()]
      const lines: string[] = []
      const seen = new Set<string>()
      for (const dim of ['execution', 'idea'] as const) {
        for (const row of ledgerV2.summary(dim)) {
          if (disabledModels.has(row.model)) continue
          const key = `${dim}/${row.model}/${row.qtype}`
          if (seen.has(key)) continue
          seen.add(key)
          const eff = isNaN(row.cnyPerDifficulty) ? '—' : `¥${row.cnyPerDifficulty.toFixed(2)}/难度点`
          const rate = isNaN(row.difficultyPerMin) ? '—' : `${row.difficultyPerMin.toFixed(1)}难度点/min`
          lines.push(`${dim}/${row.qtype}/d${row.bucket} ${row.model}: mean ${row.mean.toFixed(2)} n=${row.n.toFixed(1)} 效费比 ${eff} 时效 ${rate}`)
        }
      }
      const voids = ledgerV2.all().filter(() => false)
      void voids
      if (ex.length > 0) lines.push(`⚠️ 余额枯竭隔离: ${ex.join(', ')} —— 相关模型已自动剔除, 请写进最终战报提示用户充值`)
      if (lines.length === 0) return 'jisi_model_report: ledger is empty (cold start — all candidates equal, Thompson explores)'
      return lines.join('\n')
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
  // 工具 5：v2 契合度打分 —— 按题目特征给双维度候选 + 理由。
  ctx.tools.register(defineTool({
    name: 'jisi_pick',
    description:
      'V2 model picker (layer 2): rank candidate models for one question by fit = question-type/difficulty posterior (weighted Beta + Thompson) + public-benchmark priors. Returns top candidates per dimension (idea=for fanout, execution=for dispatch) with reasons. The main agent keeps the decision; this is evidence, not authority.',
    parameters: {
      qtype: { type: 'string', required: true, description: 'question type: web/crypto/pwn/rev/forensics/misc' },
      difficulty: { type: 'number', required: true, description: 'calibrated difficulty 0-100' },
      dimension: { type: 'string', description: 'execution | idea (default both)' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => true,
    async execute(args: { qtype: string; difficulty: number; dimension?: string }) {
      if (!QUESTION_TYPES.includes(args.qtype as QuestionType)) return `jisi_pick: unknown qtype ${args.qtype} (${QUESTION_TYPES.join('/')})`
      const catalog = await ctx.jisi.listModels()
      const allCatalog = catalog.map(m => m.id)
      const dims: Dimension[] = args.dimension === 'execution' || args.dimension === 'idea' ? [args.dimension] : ['execution', 'idea']
      const out: string[] = []
      for (const dim of dims) {
        const ranked = ledgerV2.rank(dim, args.qtype as QuestionType, args.difficulty, allCatalog, m => {
          const pr = priorsFor(m, dim, args.qtype as QuestionType)
          return { a: pr.a, b: pr.b }
        })
        out.push(`[${dim}] ${args.qtype}·难度${args.difficulty}:`)
        let i = 0
        for (const r of ranked) {
          i += 1
          const pr = priorsFor(r.model, dim, args.qtype as QuestionType)
          const basis = pr.sources.length > 0 ? `先验: ${pr.sources.join('; ')}` : '先验: 均匀(Beta(1,1), Thompson 探索)'
          out.push(`  ${i}. ${r.model} fit=${r.thompson.toFixed(2)} (后验均值 ${r.mean.toFixed(2)}, n=${r.n.toFixed(1)}) — ${basis}`)
          if (i >= 5) break
        }
      }
      return out.join('\n')
    },
  }))

  // 工具 6：v2 思路裁决 —— 对 fanout 报告批量裁决(第 0 层)。
  ctx.tools.register(defineTool({
    name: 'jisi_adjudicate',
    description:
      'V2 idea adjudication (layer 0): verdict each fanout report for one challenge in ONE call: adopted (+w idea, log-weighted by difficulty; terminal win adds nothing, terminal loss with approach-dead-end penalizes -w_f) / not-adopted (0, optional note) / pending (0, never auto-degraded). Report ids come from the [fanout:<id>] envelopes.',
    parameters: {
      code: { type: 'string', required: true },
      difficulty: { type: 'number', required: true, description: 'calibrated difficulty 0-100 (from jisi_pick/profile)' },
      verdicts: { type: 'array', required: true, description: '[{reportId, model, verdict: adopted|not-adopted|pending, note?}]' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    isConcurrencySafe: () => false,
    async execute(args: { code: string; difficulty: number; verdicts: Array<{ reportId: string; model: string; verdict: 'adopted' | 'not-adopted' | 'pending'; note?: string }> }) {
      if (args.verdicts.length === 0) return 'jisi_adjudicate: empty verdicts'
      return (ctx.jisi as { adjudicate(code: string, difficulty: number, verdicts: Array<{ reportId: string; verdict: 'adopted' | 'not-adopted' | 'pending'; note?: string; model: string }>): string })
        .adjudicate(args.code, args.difficulty, args.verdicts)
    },
  }))

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
