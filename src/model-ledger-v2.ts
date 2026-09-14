/**
 * 集思 v2 决策内核: 宏观评价账本(第 1 层)。
 * 纯逻辑模块(L0 可测), 实现 JISI-V2-DESIGN 第 1 层定稿:
 *  - 评估矩阵: 模型 × 维度 × 题型 × 难度桶, 三层收缩(单元格→题型→全局);
 *  - 聚合: 加权 Beta 后验(权重来自第 0 层对数函数);
 *  - 决策: Thompson 采样(从后验抽一个实现, 无 λ 旋钮);
 *  - 四指标: 加权终胜率(idea) / 加权首胜率(execution) / ¥/难度点 / 难度点/分钟;
 *  - 时效: 无时间衰减; 退役作废(void) + 改名继承(modelAliases, 用户裁定);
 *  - 先验: 公开基准折算成伪计数(第 2 层 benchmark-priors), 无先验格子 = Beta(1,1)。
 * @module @shence/jisi/model-ledger-v2
 */

export type Dimension = 'execution' | 'idea'
export const QUESTION_TYPES = ['web', 'crypto', 'pwn', 'rev', 'forensics', 'misc'] as const
export type QuestionType = (typeof QUESTION_TYPES)[number]
export type Attribution = 'model-weak' | 'approach-dead-end' | 'context-insufficient' | 'platform-issue'

/** 难度桶: [0,40) / [40,70) / [70,101)。 */
export function difficultyBucket(d: number): 0 | 1 | 2 {
  if (d < 40) return 0
  if (d < 70) return 1
  return 2
}

/** 一条入账记录(胜/负都记权重; context/platform 由宿主过滤不入账)。 */
export interface LedgerRecordV2 {
  model: string
  dimension: Dimension
  qtype: QuestionType
  difficulty: number
  weight: number
  win: boolean
  attribution?: Attribution
  /** 效费比原料 */
  costCny?: number
  elapsedMin?: number
  /** 胜局消化的难度点(= 难度)。 */
  difficultyPoints?: number
  /** 首轮是否拿旗(execution 首胜率专用)。 */
  firstTry?: boolean
  source: 'observation' | 'prior'
  note?: string
  at: number
}

export interface CellStats {
  a: number
  b: number
  mean: number
  n: number
  /** ¥/难度点 与 难度点/分钟(样本缺省 NaN)。 */
  cnyPerDifficulty: number
  difficultyPerMin: number
}

export interface RankEntry {
  model: string
  /** Thompson 抽样值(决策用)。 */
  thompson: number
  mean: number
  n: number
  cell: string
}

export interface ModelLedgerV2Config {
  /** 三层收缩: 单元格向父层借力的伪计数强度(样本 < shrinkageStrength 时显著借力)。 */
  shrinkageStrength?: number
  /** 改名继承映射: 新名 → 旧名(账本视为同一模型; 用户裁定)。 */
  modelAliases?: Record<string, string>
  /** 退役/作废模型清单(不进报告/决策)。 */
  voidModels?: string[]
}

const DEFAULT_CONFIG: Required<Pick<ModelLedgerV2Config, 'shrinkageStrength' | 'modelAliases' | 'voidModels'>> = {
  shrinkageStrength: 5,
  modelAliases: {},
  voidModels: [],
}

/**
 * Gamma 采样(Marsaglia-Tsang 2000, shape ≥ 1)。
 * Beta 采样 = g1/(g1+g2)。无外部依赖。
 */
export function sampleGamma(shape: number, rng: () => number = Math.random): number {
  if (shape < 1) {
    // shape<1 走 Johnk 拒绝法(先验伪计数可为小浮点)。
    return sampleGamma(shape + 1, rng) * Math.pow(rng(), 1 / shape)
  }
  const d = shape - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  for (;;) {
    let x = 0
    let v = 0
    do {
      x = normalSample(rng)
      v = 1 + c * x
    } while (v <= 0)
    v = v * v * v
    const u = rng()
    if (u < 1 - 0.0331 * x * x * x * x) return d * v
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v
  }
}

/** Box-Muller 正态采样。 */
function normalSample(rng: () => number): number {
  const u1 = Math.max(rng(), 1e-12)
  const u2 = rng()
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

/** Beta 采样(决策 = Thompson)。 */
export function sampleBeta(a: number, b: number, rng: () => number = Math.random): number {
  const g1 = sampleGamma(a, rng)
  const g2 = sampleGamma(b, rng)
  return g1 / (g1 + g2)
}

export class ModelLedgerV2 {
  private readonly records: LedgerRecordV2[] = []
  private readonly config: Required<Pick<ModelLedgerV2Config, 'shrinkageStrength' | 'modelAliases' | 'voidModels'>> & ModelLedgerV2Config

  constructor(config: ModelLedgerV2Config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  static fromJSON(data: unknown, config?: ModelLedgerV2Config): ModelLedgerV2 {
    const ledger = new ModelLedgerV2(config)
    const records = (data as { records?: LedgerRecordV2[] } | undefined)?.records ?? []
    for (const r of records) if (r !== null && typeof r === 'object') ledger.records.push(r)
    return ledger
  }

  toJSON(): { records: LedgerRecordV2[] } {
    return { records: [...this.records] }
  }

  /** 记一条(加权)。 */
  record(r: Omit<LedgerRecordV2, 'at'> & { at?: number }): void {
    this.records.push({ ...r, at: r.at ?? Date.now() })
  }

  /** 所有记录(报告/分析用)。 */
  all(): LedgerRecordV2[] {
    return [...this.records]
  }

  /** 规范化模型名(别名继承)。 */
  private canon(model: string): string {
    let m = model
    let guard = 0
    while (this.config.modelAliases[m] !== undefined && guard < 8) {
      m = this.config.modelAliases[m]
      guard += 1
    }
    return m
  }

  /** 单元格伪计数(仅观测; 先验在聚合时叠加)。 */
  private cellCounts(model: string, dimension: Dimension, qtype: QuestionType, bucket: 0 | 1 | 2): { a: number; b: number } {
    let a = 0
    let b = 0
    for (const r of this.records) {
      if (r.dimension !== dimension) continue
      if (this.canon(r.model) !== model) continue
      if (r.qtype !== qtype) continue
      if (difficultyBucket(r.difficulty) !== bucket) continue
      if (r.win) a += r.weight
      else b += r.weight
    }
    return { a, b }
  }

  /** 三层收缩后的有效伪计数(先验加在这里: L0 层叠全局先验)。 */
  effectiveCounts(
    model: string, dimension: Dimension, qtype: QuestionType, bucket: 0 | 1 | 2,
    priorA = 0, priorB = 0,
  ): { a: number; b: number; cellA: number; cellB: number; typeA: number; typeB: number; globalA: number; globalB: number } {
    const m = this.canon(model)
    const cell = this.cellCounts(m, dimension, qtype, bucket)
    const type = this.typeCounts(m, dimension, qtype)
    const glob = this.globalCounts(m, dimension)
    // 收缩(实证贝叶斯借力): 单元格样本不足时向父层借, 空父层跳过(不稀释)——
    // 题型有数据 → 借题型后验; 题型空但全局有 → 直接借全局; 全空 → 不注入(保持全探索)。
    const s = this.config.shrinkageStrength
    let cellA = cell.a
    let cellB = cell.b
    if (cellA + cellB === 0) {
      let parentMean: number | undefined
      if (type.a + type.b > 0) parentMean = (type.a + 1) / (type.a + type.b + 2)
      else if (glob.a + glob.b > 0) parentMean = (glob.a + 1) / (glob.a + glob.b + 2)
      if (parentMean !== undefined) {
        cellA = parentMean * s
        cellB = (1 - parentMean) * s
      }
    }
    return { a: cellA + priorA, b: cellB + priorB, cellA: cell.a, cellB: cell.b, typeA: type.a, typeB: type.b, globalA: glob.a, globalB: glob.b }
  }

  private typeCounts(model: string, dimension: Dimension, qtype: QuestionType): { a: number; b: number } {
    let a = 0
    let b = 0
    for (const r of this.records) {
      if (r.dimension !== dimension || this.canon(r.model) !== model || r.qtype !== qtype) continue
      if (r.win) a += r.weight
      else b += r.weight
    }
    return { a, b }
  }

  private globalCounts(model: string, dimension: Dimension): { a: number; b: number } {
    let a = 0
    let b = 0
    for (const r of this.records) {
      if (r.dimension !== dimension || this.canon(r.model) !== model) continue
      if (r.win) a += r.weight
      else b += r.weight
    }
    return { a, b }
  }

  /** 单元格统计(含收缩+先验)。 */
  cellStats(
    model: string, dimension: Dimension, qtype: QuestionType, bucket: 0 | 1 | 2,
    priorA = 0, priorB = 0,
  ): CellStats {
    const { a, b, cellA, cellB } = this.effectiveCounts(model, dimension, qtype, bucket, priorA, priorB)
    const mean = (a + 1) / (a + b + 2)
    let cost = 0
    let pts = 0
    let mins = 0
    for (const r of this.records) {
      if (r.dimension !== dimension || this.canon(r.model) !== model || r.qtype !== qtype) continue
      if (difficultyBucket(r.difficulty) !== bucket) continue
      cost += r.costCny ?? 0
      mins += r.elapsedMin ?? 0
      if (r.win) pts += r.difficultyPoints ?? r.difficulty
    }
    return {
      a, b, mean,
      n: cellA + cellB,
      cnyPerDifficulty: pts > 0 ? cost / pts : Number.NaN,
      difficultyPerMin: mins > 0 ? pts / mins : Number.NaN,
    }
  }

  /**
   * Thompson 排名: 每个候选抽一个后验实现, 降序。
   * 返回该难度桶(按难度插值到桶内)的样本值。
   */
  rank(
    dimension: Dimension, qtype: QuestionType, difficulty: number,
    candidates: readonly string[],
    priors: (model: string) => { a: number; b: number } = () => ({ a: 0, b: 0 }),
    rng: () => number = Math.random,
  ): RankEntry[] {
    const bucket = difficultyBucket(difficulty)
    const out: RankEntry[] = []
    for (const model of candidates) {
      const m = this.canon(model)
      if (this.config.voidModels.includes(m)) continue
      const p = priors(m)
      const { a, b, n } = this.cellStats(m, dimension, qtype, bucket, p.a, p.b)
      out.push({
        model: m,
        thompson: sampleBeta(a + 1, b + 1, rng),
        mean: (a + 1) / (a + b + 2),
        n,
        cell: `${dimension}/${qtype}/d${bucket}`,
      })
    }
    return out.sort((x, y) => y.thompson - x.thompson)
  }

  /** 四指标之一/二: idea 加权终胜率、execution 加权首胜率(全格汇总, 供 model_report)。 */
  summary(dimension: Dimension): Array<{ model: string; qtype: QuestionType; bucket: number; mean: number; n: number; cnyPerDifficulty: number; difficultyPerMin: number }> {
    const out: Array<{ model: string; qtype: QuestionType; bucket: number; mean: number; n: number; cnyPerDifficulty: number; difficultyPerMin: number }> = []
    const models = new Set<string>()
    for (const r of this.records) if (r.dimension === dimension) models.add(this.canon(r.model))
    for (const m of models) {
      if (this.config.voidModels.includes(m)) continue
      for (const qtype of QUESTION_TYPES) {
        for (const bucket of [0, 1, 2] as const) {
          const st = this.cellStats(m, dimension, qtype, bucket)
          if (st.n <= 0) continue
          out.push({ model: m, qtype, bucket, mean: st.mean, n: st.n, cnyPerDifficulty: st.cnyPerDifficulty, difficultyPerMin: st.difficultyPerMin })
        }
      }
    }
    return out.sort((x, y) => y.mean - x.mean)
  }
}
