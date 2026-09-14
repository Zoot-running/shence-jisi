/**
 * 第 0 层对数权重函数 + 第 2 层契合度打分(纯逻辑)。
 * 权重性质: 难题胜不爆炸(难度90→+1.53), 送分题败最重但不倾家荡产(难度20→−0.81)。
 * @module @shence/jisi/score
 */

/** 胜权重: +k_w·ln(1+难度/25)。 */
export function winWeight(difficulty: number, kW = 1): number {
  const d = Math.max(difficulty, 0)
  return kW * Math.log(1 + d / 25)
}

/** 败权重(approach-dead-end 罚思路模型): −k_f·ln(1+25/难度)。 */
export function failWeight(difficulty: number, kF = 1): number {
  const d = Math.max(difficulty, 0.1)
  return kF * Math.log(1 + 25 / d)
}

export interface PickCandidate {
  model: string
  thompson: number
  mean: number
  n: number
  /** 后验来源描述。 */
  basis: string
  /** 先验来源(若有)。 */
  priorSources: string[]
}

export interface PickResult {
  dimension: 'execution' | 'idea'
  difficulty: number
  candidates: PickCandidate[]
}

/**
 * 契合度打分: 题型三桶后验按本题难度插值(先粗后细):
 * 本题难度所在桶为主, 邻桶按距离加权 0.25 参与——难度带边界处的模型不因一桶之差被误杀。
 */
export function interpolatedCell(
  bucket: 0 | 1 | 2, difficulty: number,
  stats: (b: 0 | 1 | 2) => { mean: number; n: number },
): { mean: number; n: number } {
  const main = stats(bucket)
  let mean = main.mean
  let n = main.n
  const w = 0.25
  if (bucket > 0 && difficulty < 55) {
    const left = stats((bucket - 1) as 0 | 1 | 2)
    if (left.n > 0) { mean = (mean * (1 - w) + left.mean * w); n = main.n + left.n }
  }
  if (bucket < 2 && difficulty >= 55) {
    const right = stats((bucket + 1) as 0 | 1 | 2)
    if (right.n > 0) { mean = (mean * (1 - w) + right.mean * w); n = main.n + right.n }
  }
  return { mean, n }
}
