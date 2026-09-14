/**
 * L0: 集思 v2 决策内核纯逻辑。
 * 覆盖: 加权 Beta 三层收缩 / Thompson 采样分布性质 / 难度校准 / 先验折算 k 公式 / 对数权重。
 */
import { describe, expect, it } from 'vitest'
import { ModelLedgerV2, difficultyBucket, sampleBeta, sampleGamma } from '../src/model-ledger-v2.ts'
import { calibratedDifficulty, difficultyState, observeDifficulty, priorFromScore } from '../src/difficulty.ts'
import { priorStrength, priorsFor } from '../src/benchmark-priors.ts'
import { failWeight, winWeight } from '../src/score.ts'

describe('gamma/beta 采样', () => {
  it('gamma 均值近似 shape/rate=1(抽样 20000)', () => {
    let sum = 0
    const n = 20000
    for (let i = 0; i < n; i += 1) sum += sampleGamma(2)
    const mean = sum / n
    expect(Math.abs(mean - 2)).toBeLessThan(0.08)
  })
  it('beta 均值近似 a/(a+b)', () => {
    let sum = 0
    const n = 20000
    for (let i = 0; i < n; i += 1) sum += sampleBeta(3, 7)
    expect(Math.abs(sum / n - 0.3)).toBeLessThan(0.02)
  })
})

describe('难度校准(第 0 层)', () => {
  it('宿主映射: 1000 分 ≈ 81, 200 分 ≈ 28', () => {
    expect(priorFromScore(1000)).toBe(81)
    expect(priorFromScore(200)).toBe(28)
  })
  it('失败升难度、成功降难度(071 式: easy 先验连败爬升)', () => {
    const st = observeDifficulty(observeDifficulty(observeDifficulty(difficultyState(priorFromScore(200)), false), false), false)
    expect(calibratedDifficulty(st)).toBeGreaterThan(priorFromScore(200))
  })
  it('归因门控: context/platform 不调用 observeDifficulty(由宿主保证)', () => {
    const st = difficultyState(priorFromScore(300))
    expect(calibratedDifficulty(st)).toBe(priorFromScore(300))
  })
})

describe('对数权重(第 0 层)', () => {
  it('难题胜不爆炸、送分题败最重但不抵消', () => {
    expect(winWeight(90)).toBeCloseTo(1.526, 2)
    expect(failWeight(20)).toBeCloseTo(0.811, 2)
    expect(winWeight(90) - failWeight(20)).toBeGreaterThan(0.7)
  })
  it('中题胜 + 送分题败仍有净余', () => {
    expect(winWeight(55) - failWeight(20)).toBeGreaterThan(0.3)
  })
})

describe('先验折算 k(第 2 层)', () => {
  it('k = discount/(4·SE²): CyberGym(88.1, n=100) k≈59', () => {
    const k = priorStrength(88.1, 100)
    expect(k).toBeGreaterThan(50)
    expect(k).toBeLessThan(70)
  })
  it('priorsFor: flash 的 execution/misc 有 CyberGym 先验, kimi 均匀', () => {
    const flash = priorsFor('deepseek-flash', 'execution', 'misc')
    expect(flash.a).toBeGreaterThan(0)
    expect(flash.sources.length).toBeGreaterThan(0)
    const kimi = priorsFor('kimi-k3', 'idea', 'web')
    expect(kimi.a).toBe(0)
    expect(kimi.b).toBe(0)
  })
})

describe('ModelLedgerV2 三层收缩 + Thompson', () => {
  it('样本薄的新题型向题型/全局借力(不裸奔 0.5)', () => {
    const l = new ModelLedgerV2()
    // 全局: flash 在 crypto/execution 很强
    for (let i = 0; i < 20; i += 1) l.record({ model: 'flash', dimension: 'execution', qtype: 'crypto', difficulty: 50, weight: 1, win: true, source: 'observation' })
    // 新题型 web: 0 样本 → 收缩后均值应明显高于 0.5
    const st = l.cellStats('flash', 'execution', 'web', difficultyBucket(50))
    expect(st.n).toBe(0)
    expect(st.mean).toBeGreaterThan(0.8)
  })
  it('Thompson 冷启动模型有探索机会(σ 大 → 抽样可能胜出)', () => {
    const l = new ModelLedgerV2()
    for (let i = 0; i < 20; i += 1) l.record({ model: 'flash', dimension: 'idea', qtype: 'pwn', difficulty: 80, weight: 1, win: true, source: 'observation' })
    let proWins = 0
    const n = 2000
    for (let i = 0; i < n; i += 1) {
      const ranked = l.rank('idea', 'pwn', 80, ['flash', 'pro'], () => ({ a: 0, b: 0 }))
      if (ranked[0]?.model === 'pro') proWins += 1
    }
    // 冷启动 pro 有一定概率赢(探索项), 但远低于一半(flash 有真证据)
    expect(proWins).toBeGreaterThan(20)
    expect(proWins).toBeLessThan(n / 3)
  })
  it('退役作废: void 模型不参与 rank', () => {
    const l = new ModelLedgerV2({ voidModels: ['dead-model'] })
    l.record({ model: 'dead-model', dimension: 'idea', qtype: 'web', difficulty: 50, weight: 1, win: true, source: 'observation' })
    const ranked = l.rank('idea', 'web', 50, ['dead-model', 'alive'], () => ({ a: 0, b: 0 }))
    expect(ranked.map(r => r.model)).not.toContain('dead-model')
  })
  it('效费比原料: ¥/难度点 与 难度点/分钟', () => {
    const l = new ModelLedgerV2()
    l.record({ model: 'flash', dimension: 'execution', qtype: 'crypto', difficulty: 50, weight: 1, win: true, costCny: 2, elapsedMin: 10, difficultyPoints: 50, source: 'observation' })
    const st = l.cellStats('flash', 'execution', 'crypto', difficultyBucket(50))
    expect(st.cnyPerDifficulty).toBeCloseTo(0.04, 3)
    expect(st.difficultyPerMin).toBeCloseTo(5, 3)
  })
})
