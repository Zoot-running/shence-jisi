/**
 * 公开基准 → Beta 先验折算(第 2 层)。
 * k 由公式推导: k = priorDiscount / (4·SE²), SE = √(p(1−p)/n_tasks)
 * (先验精度匹配基准自身测量误差; priorDiscount = 域偏移折扣, 唯一主观参数)。
 * 只做 like-for-like; 每个先验带出处(source + date)。
 * @module @shence/jisi/benchmark-priors
 */

import type { Dimension, QuestionType } from './model-ledger-v2.ts'

export interface BenchmarkSource {
  /** 基准名。 */
  name: string
  /** 分数(0-100)。 */
  score: number
  /** 基准任务数(用于 SE)。 */
  nTasks: number
  /** 折算目标。 */
  dimension: Dimension
  qtype: QuestionType
  /** 出处链接/说明。 */
  source: string
  /** 记录日期。 */
  date: string
}

/**
 * 已录先验(2026-09-14, like-for-like 取数)。
 * - deepseek-flash(V4.1): DeepSeek 官方 changelog 2026-09-10
 *   CyberGym 88.1 / SEC-Bench Pro 62.8 / ExploitGym 15.3
 *   (https://api-docs.deepseek.com/updates/);
 *   n_tasks 为估计值: CyberGym≈100 / SEC-Bench≈500 / ExploitGym≈40(记档, 可校准)。
 * - v7.6 补录(2026-09-17, 公开 CyberGym 榜单 https://www.datalearner.com/benchmarks/cybergym;
 *   公共数据, 非历史答题记忆, 规则 6 合规): deepseek-v4-pro 83.3 / glm-5.3 84.5 / kimi-k3 80。
 *   like-for-like: 榜单是 GLM-5.3 强版, glm-5.3-flash 变体不挂此先验(不虚标)。
 * - 其余模型无公开安全域数据 → Beta(1,1) 均匀, 探索交给 Thompson。
 */
export const BENCHMARK_PRIORS: Record<string, BenchmarkSource[]> = {
  'deepseek-flash': [
    { name: 'CyberGym', score: 88.1, nTasks: 100, dimension: 'execution', qtype: 'misc', source: 'DeepSeek changelog 2026-09-10', date: '2026-09-10' },
    { name: 'SEC-Bench Pro', score: 62.8, nTasks: 500, dimension: 'idea', qtype: 'misc', source: 'DeepSeek changelog 2026-09-10', date: '2026-09-10' },
    { name: 'ExploitGym', score: 15.3, nTasks: 40, dimension: 'execution', qtype: 'pwn', source: 'DeepSeek changelog 2026-09-10', date: '2026-09-10' },
  ],
  'deepseek-v4-pro': [
    { name: 'CyberGym', score: 83.3, nTasks: 100, dimension: 'execution', qtype: 'misc', source: 'datalearner CyberGym 榜单', date: '2026-09-17' },
  ],
  'glm-5.3': [
    { name: 'CyberGym', score: 84.5, nTasks: 100, dimension: 'execution', qtype: 'misc', source: 'datalearner CyberGym 榜单', date: '2026-09-17' },
  ],
  'kimi-k3': [
    { name: 'CyberGym', score: 80, nTasks: 100, dimension: 'execution', qtype: 'misc', source: 'datalearner CyberGym 榜单', date: '2026-09-17' },
  ],
}

/** 域偏移折扣(唯一主观参数, 全局配置)。 */
export const PRIOR_DISCOUNT = 0.25

/** k = priorDiscount / (4·SE²)。 */
export function priorStrength(score: number, nTasks: number, discount = PRIOR_DISCOUNT): number {
  const p = Math.min(Math.max(score / 100, 0.001), 0.999)
  const se2 = (p * (1 - p)) / Math.max(nTasks, 1)
  return discount / (4 * se2)
}

export interface PriorSpec { a: number; b: number; sources: string[] }

/**
 * 某模型的 (维度, 题型) 先验伪计数。
 * 同格多源合并(加和伪计数); 无源 = (0,0)。
 */
export function priorsFor(
  model: string, dimension: Dimension, qtype: QuestionType,
  table: Record<string, BenchmarkSource[]> = BENCHMARK_PRIORS,
): PriorSpec {
  let a = 0
  let b = 0
  const sources: string[] = []
  for (const src of table[model] ?? []) {
    if (src.dimension !== dimension || src.qtype !== qtype) continue
    const k = priorStrength(src.score, src.nTasks)
    const p = src.score / 100
    a += p * k
    b += (1 - p) * k
    sources.push(`${src.name}(${src.score},n=${src.nTasks},k≈${k.toFixed(0)})@${src.date}`)
  }
  return { a, b, sources }
}
