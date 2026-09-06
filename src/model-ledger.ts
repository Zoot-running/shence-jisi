/**
 * 集思模型能力账本（纯逻辑，L0 可测）。
 * 泛化维度：execution（执行战绩，按难度细分）、idea（思路质量，被采纳/验证可行=胜，死路=负）。
 * 越用越了解：Laplace 平滑胜率排序；同分按价格序。随 run 序列化落盘（本地私知）。
 * @module @shence/jisi/model-ledger
 */

/** 已支持的账本维度。 */
export type LedgerDimension = 'execution' | 'idea'

export interface ModelLedgerData {
  models: Record<string, {
    dimensions: Record<string, Record<string, { attempts: number; wins: number }>>
  }>
}

export class ModelLedger {
  private readonly models = new Map<string, Map<string, Map<string, { attempts: number; wins: number }>>>()

  static fromJSON(data: unknown): ModelLedger {
    const ledger = new ModelLedger()
    const models = (data as { models?: ModelLedgerData['models'] } | undefined)?.models ?? {}
    for (const [model, dims] of Object.entries(models)) {
      for (const [dimension, keys] of Object.entries(dims?.dimensions ?? {})) {
        for (const [key, record] of Object.entries(keys)) {
          if (record === undefined || typeof record.attempts !== 'number') continue
          ledger.bucket(model, dimension, key).attempts = record.attempts
          ledger.bucket(model, dimension, key).wins = record.wins
        }
      }
    }
    return ledger
  }

  toJSON(): ModelLedgerData {
    const models: ModelLedgerData['models'] = {}
    for (const [model, dims] of this.models) {
      const dimensions: ModelLedgerData['models'][string]['dimensions'] = {}
      for (const [dimension, keys] of dims) {
        for (const [key, record] of keys) dimensions[dimension] = { ...(dimensions[dimension] ?? {}), [key]: record }
      }
      models[model] = { dimensions }
    }
    return { models }
  }

  private bucket(model: string, dimension: string, key: string): { attempts: number; wins: number } {
    const dims = this.models.get(model) ?? new Map<string, Map<string, { attempts: number; wins: number }>>()
    this.models.set(model, dims)
    const keys = dims.get(dimension) ?? new Map<string, { attempts: number; wins: number }>()
    dims.set(dimension, keys)
    const existing = keys.get(key)
    if (existing !== undefined) return existing
    const created = { attempts: 0, wins: 0 }
    keys.set(key, created)
    return created
  }

  /** 记一局：某模型在（维度, 细分键）上的一次结果（win=true 为胜）。 */
  record(model: string, dimension: LedgerDimension, key: string, win: boolean): void {
    const bucket = this.bucket(model, dimension, key)
    bucket.attempts += 1
    if (win) bucket.wins += 1
  }

  /** 平滑胜率（Laplace +1/+2）；无记录 = 0.5。 */
  rate(model: string, dimension: LedgerDimension, key: string): number {
    const bucket = this.models.get(model)?.get(dimension)?.get(key)
    if (bucket === undefined || bucket.attempts === 0) return 0.5
    return (bucket.wins + 1) / (bucket.attempts + 2)
  }

  /** 按（维度, 细分键）给候选模型排序：胜率高者前；同分（<1%）按价格序。 */
  rank(dimension: LedgerDimension, key: string, candidates: readonly string[], priceOrder: readonly string[] = []): string[] {
    const priceOf = (model: string): number => priceOrder.includes(model) ? priceOrder.indexOf(model) : priceOrder.length
    return [...candidates].sort((a, b) => {
      const ra = this.rate(a, dimension, key)
      const rb = this.rate(b, dimension, key)
      if (Math.abs(ra - rb) > 0.01) return rb - ra
      return priceOf(a) - priceOf(b)
    })
  }

  /** 人读摘要（jisi_model_report 工具输出）。 */
  summary(): Array<{ model: string; dimension: string; key: string; attempts: number; wins: number; rate: number }> {
    const out: Array<{ model: string; dimension: string; key: string; attempts: number; wins: number; rate: number }> = []
    for (const [model, dims] of this.models) {
      for (const [dimension, keys] of dims) {
        for (const [key, record] of keys) {
          out.push({ model, dimension, key, attempts: record.attempts, wins: record.wins, rate: this.rate(model, dimension as LedgerDimension, key) })
        }
      }
    }
    return out.sort((a, b) => b.rate - a.rate)
  }
}
