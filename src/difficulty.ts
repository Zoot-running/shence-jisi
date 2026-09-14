/**
 * 通用问题难度评分(第 0 层, 0-100)。
 * 集思不认业务分: 宿主把业务指标映射成难度初值(映射表宿主可换),
 * 终局观测做在线校准(Beta 后验), 归因门控(context/platform 不更新难度)。
 * @module @shence/jisi/difficulty
 */

/** 默认宿主映射(CTF 分值 → 难度初值): 平滑指数函数。 */
export function priorFromScore(score: number): number {
  if (score <= 0) return 0
  return Math.min(100, Math.round(100 * (1 - Math.exp(-score / 600))))
}

/** 难度先验折算成成功率 Beta 伪计数(k = 先验强度)。 */
export function priorToPseudo(difficultyPrior: number, k = 5): { a: number; b: number } {
  const p = 1 - difficultyPrior / 100
  return { a: p * k, b: (1 - p) * k }
}

export interface DifficultyState {
  /** 宿主映射初值。 */
  prior: number
  /** 观测: 胜/负(已按归因门控)。 */
  wins: number
  fails: number
  /** 先验伪计数强度。 */
  k: number
}

export function difficultyState(prior: number, k = 5): DifficultyState {
  return { prior, wins: 0, fails: 0, k }
}

/** 在线校准: 难度 = 100 × (1 − 平滑成功率)。 */
export function calibratedDifficulty(state: DifficultyState): number {
  const { a, b } = priorToPseudo(state.prior, state.k)
  const p = (a + state.wins) / (a + b + state.wins + state.fails)
  return Math.round(100 * (1 - p))
}

/** 终局入账(门控后的胜/负)。 */
export function observeDifficulty(state: DifficultyState, win: boolean): DifficultyState {
  return win
    ? { ...state, wins: state.wins + 1 }
    : { ...state, fails: state.fails + 1 }
}
