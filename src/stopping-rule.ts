/**
 * 不可行性判定的停止规则(第 6 层 L2, 纯逻辑 L0)。
 * 序贯弃权: 判死不是单点判断, 是证据序列上的停止规则。
 * 输入全是客观计数(filtered-failed / 无进展时长 / 难度后验 / 攻击面覆盖 / 兵力),
 * 输出 {continue | escalate | judge-dead} + 理由。
 * 非对称损失: 错弃可解题 > 有界超支 → judge-dead 阈值保守(必须 escalate 穷尽 + 覆盖饱和 + 兵力下限)。
 * @module @shence/jisi/stopping-rule
 */

export interface StoppingInput {
  /** 该题已投入的不同思路数(兵力)。 */
  troops: number
  /** 过滤平台故障后的失败终态数。 */
  filteredFailed: number
  /** 最近一次进展距今分钟数(0 = 刚有进展)。 */
  noProgressMin: number
  /** 校准后难度 0-100。 */
  difficulty: number
  /** 攻击面覆盖率 0-1(死路清单 ÷ 题型攻击面宇宙)。 */
  coverageRatio: number
  /** 该题剩余可得分数(宿主换算; 判死的机会成本)。 */
  remainingPoints: number
  /** 已征集模型占目录比例(征集穷尽度)。 */
  modelExhaustion: number
  /** 已发起 R2 次数。 */
  r2Count: number
}

export interface StoppingConfig {
  /** M1: 过滤失败数 ≥ 此值 → 触发升级建议。 */
  escalateFailedMin: number
  /** M2: 过滤失败数 ≥ 此值 且覆盖饱和 → 判死候选。 */
  deadFailedMin: number
  /** 无进展分钟数 → 视同一次失败(慢死检测)。 */
  stallMinutesAsFail: number
  /** 覆盖饱和阈值(覆盖率达到即"该试的都试了")。 */
  coverageSaturated: number
  /** 判死兵力下限。 */
  minTroopsToDie: number
  /** 判死征集穷尽下限(目录模型比例)。 */
  minModelExhaustion: number
  /** 判死最大 R2 次数(升级穷尽)。 */
  maxR2: number
}

export const DEFAULT_STOPPING: StoppingConfig = {
  escalateFailedMin: 2,
  deadFailedMin: 4,
  stallMinutesAsFail: 20,
  coverageSaturated: 0.8,
  minTroopsToDie: 3,
  minModelExhaustion: 1.0,
  maxR2: 2,
}

export type StoppingAction = 'continue' | 'escalate' | 'judge-dead'

export interface StoppingResult {
  action: StoppingAction
  reasons: string[]
}

export function decide(input: StoppingInput, cfg: StoppingConfig = DEFAULT_STOPPING): StoppingResult {
  const effectiveFails = input.filteredFailed + Math.floor(input.noProgressMin / cfg.stallMinutesAsFail)
  const reasons: string[] = []
  const escalated = input.r2Count >= cfg.maxR2
  const coverageSaturated = input.coverageRatio >= cfg.coverageSaturated
  const exhausted = input.modelExhaustion >= cfg.minModelExhaustion
  const troopsEnough = input.troops >= cfg.minTroopsToDie

  const deadConditions = {
    fails: effectiveFails >= cfg.deadFailedMin,
    coverage: coverageSaturated,
    exhausted,
    troops: troopsEnough,
    escalated,
  }
  const deadCount = Object.values(deadConditions).filter(Boolean).length
  if (deadConditions.fails && deadConditions.coverage && deadConditions.exhausted && deadConditions.troops && deadConditions.escalated) {
    reasons.push(`不可行性证据齐备: 过滤失败 ${effectiveFails}≥${cfg.deadFailedMin}, 覆盖 ${(input.coverageRatio * 100).toFixed(0)}%≥${cfg.coverageSaturated * 100}%, 模型征集穷尽, 兵力 ${input.troops}≥${cfg.minTroopsToDie}, R2 已穷尽 ${input.r2Count}/${cfg.maxR2}`)
    reasons.push('判死建议: 分数机会成本 = 剩余 ' + input.remainingPoints + ' 分; 若判死请 report(failed, why=approach-dead-end) 留档')
    return { action: 'judge-dead', reasons }
  }
  if (deadCount >= 3) {
    reasons.push(`接近判死(${deadCount}/5 条件满足): ${JSON.stringify(deadConditions)}`)
  }
  if (effectiveFails >= cfg.escalateFailedMin && !escalated) {
    reasons.push(`过滤失败 ${effectiveFails}≥${cfg.escalateFailedMin} 且 R2 未穷尽(${input.r2Count}/${cfg.maxR2}) → 升级: xiaochang_refanout 二次征集(带入死路/缺口)`)
    return { action: 'escalate', reasons }
  }
  if (input.noProgressMin >= cfg.stallMinutesAsFail && input.r2Count === 0) {
    reasons.push(`无进展 ${input.noProgressMin}min ≥ ${cfg.stallMinutesAsFail}min → 建议换思路或补上下文(先于 R2 的轻升级)`)
    return { action: 'escalate', reasons }
  }
  reasons.push(`继续: 过滤失败 ${effectiveFails}/${cfg.deadFailedMin}, 覆盖 ${(input.coverageRatio * 100).toFixed(0)}%, 兵力 ${input.troops}, 难度 ${input.difficulty}`)
  return { action: 'continue', reasons }
}
