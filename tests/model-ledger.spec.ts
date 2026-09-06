/**
 * L0：集思模型能力账本（纯逻辑）。
 * 覆盖：双维度记账、Laplace 平滑排序、价格 tiebreak、JSON 往返、摘要。
 */
import { describe, expect, it } from 'vitest'
import { ModelLedger } from '../src/model-ledger.ts'

const candidates = ['kimi-k3', 'deepseek-v4-flash', 'deepseek-v4-pro']
const priceOrder = ['deepseek-v4-flash', 'kimi-k3', 'deepseek-v4-pro']

describe('ModelLedger', () => {
  it('cold start: all rates 0.5, cheapest first', () => {
    const ledger = new ModelLedger()
    expect(ledger.rank('execution', 'hard', candidates, priceOrder)).toEqual([
      'deepseek-v4-flash', 'kimi-k3', 'deepseek-v4-pro',
    ])
  })

  it('execution dimension learns per difficulty', () => {
    const ledger = new ModelLedger()
    ledger.record('deepseek-v4-pro', 'execution', 'hard', true)
    ledger.record('deepseek-v4-pro', 'execution', 'hard', true)
    ledger.record('kimi-k3', 'execution', 'hard', false)
    expect(ledger.rank('execution', 'hard', candidates, priceOrder)[0]).toBe('deepseek-v4-pro')
    // easy 维度不受 hard 战绩污染
    expect(ledger.rank('execution', 'easy', candidates, priceOrder)[0]).toBe('deepseek-v4-flash')
  })

  it('idea dimension tracks adopted vs dead-end separately from execution', () => {
    const ledger = new ModelLedger()
    ledger.record('kimi-k3', 'idea', 'web', true)
    ledger.record('kimi-k3', 'idea', 'web', true)
    ledger.record('deepseek-v4-pro', 'idea', 'web', false)
    expect(ledger.rank('idea', 'web', candidates, priceOrder)[0]).toBe('kimi-k3')
    // execution 不受 idea 战绩影响
    expect(ledger.rank('execution', 'web', candidates, priceOrder)[0]).toBe('deepseek-v4-flash')
  })

  it('JSON roundtrip preserves records', () => {
    const ledger = new ModelLedger()
    ledger.record('kimi-k3', 'execution', 'hard', true)
    ledger.record('kimi-k3', 'idea', 'crypto', false)
    const restored = ModelLedger.fromJSON(JSON.parse(JSON.stringify(ledger.toJSON())))
    expect(restored.rank('execution', 'hard', candidates, priceOrder)[0]).toBe('kimi-k3')
    expect(restored.summary()).toHaveLength(2)
  })

  it('summary lists human-readable rows sorted by rate', () => {
    const ledger = new ModelLedger()
    ledger.record('a', 'execution', 'hard', true)
    ledger.record('a', 'execution', 'hard', true)
    ledger.record('b', 'execution', 'hard', false)
    const summary = ledger.summary()
    expect(summary[0]!.model).toBe('a')
    expect(summary[0]!.rate).toBeGreaterThan(summary[1]!.rate)
  })
})
