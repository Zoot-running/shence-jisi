/**
 * L0: 不可行性判定框架(攻击面覆盖 + 停止规则)。
 * 覆盖: 关键词归入、覆盖饱和、升级/判死阈值、非对称保守(判死须五条件齐备)、慢死检测。
 */
import { describe, expect, it } from 'vitest'
import { decide, DEFAULT_STOPPING, type StoppingInput } from '../src/stopping-rule.ts'

function base(over: Partial<StoppingInput> = {}): StoppingInput {
  return {
    troops: 2, filteredFailed: 0, noProgressMin: 0, difficulty: 60,
    coverageRatio: 0.2, remainingPoints: 1000, modelExhaustion: 1.0, r2Count: 0,
    ...over,
  }
}

describe('停止规则(L2)', () => {
  it('低证据 → continue', () => {
    const r = decide(base())
    expect(r.action).toBe('continue')
  })
  it('过滤失败 ≥M1 且 R2 未穷尽 → escalate', () => {
    const r = decide(base({ filteredFailed: 2 }))
    expect(r.action).toBe('escalate')
  })
  it('无进展 ≥ stall 且没发过 R2 → escalate(慢死检测)', () => {
    const r = decide(base({ noProgressMin: 25 }))
    expect(r.action).toBe('escalate')
  })
  it('R2 穷尽后同样的失败 → 不再 escalate(升级穷尽)', () => {
    const r = decide(base({ filteredFailed: 2, r2Count: 2 }))
    expect(r.action).not.toBe('escalate')
  })
  it('五条件齐备 → judge-dead(非对称保守: 缺一不可)', () => {
    const r = decide(base({
      filteredFailed: 5, noProgressMin: 0, coverageRatio: 0.85,
      troops: 3, modelExhaustion: 1.0, r2Count: 2,
    }))
    expect(r.action).toBe('judge-dead')
  })
  it('只差兵力下限 → 不判死(保守)', () => {
    const r = decide(base({
      filteredFailed: 5, coverageRatio: 0.85, troops: 2, modelExhaustion: 1.0, r2Count: 2,
    }))
    expect(r.action).not.toBe('judge-dead')
  })
  it('只差覆盖饱和 → 不判死', () => {
    const r = decide(base({
      filteredFailed: 5, coverageRatio: 0.5, troops: 3, modelExhaustion: 1.0, r2Count: 2,
    }))
    expect(r.action).not.toBe('judge-dead')
  })
})
