/**
 * F35 余额枯竭检测与隔离 sidecar（纯逻辑 + node:fs，无 DSH 运行时依赖，L0 可测）。
 * 检测: 401/402/403/429 + 余额语义(kimi 文案 / zhipu code 1113 / 通用 balance|quota)。
 * sidecar: DSH_HOME/storages/provider-balance-exhausted.jsonl —— 跨会话/跨进程共享的
 * 唯一可靠信道(与分叉信箱同机制)，集思每次 fanout/派单读它把该 provider 模型全部隔离。
 * @module @shence/jisi/balance-guard
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface BalanceExhaustedRecord {
  provider: string
  model: string
  detail: string
  status: number
  at: number
}

const BALANCE_PATTERN = /(balance|insufficient|余额|quota|not enough|out of money)/i
const STATUS_SET = new Set([401, 402, 403, 429])

export function isBalanceExhausted(status: number, text: string): boolean {
  return STATUS_SET.has(status) && BALANCE_PATTERN.test(text)
}

export function recordBalanceExhausted(provider: string, model: string, detail: string, status: number): void {
  try {
    const dir = join(process.env.DSH_HOME ?? '.', 'storages')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'provider-balance-exhausted.jsonl'),
      JSON.stringify({ provider, model, detail: detail.slice(0, 300), status, at: Date.now() }) + '\n')
  } catch { /* sidecar 写失败不阻断错误上报 */ }
}

export function readBalanceExhausted(): BalanceExhaustedRecord[] {
  try {
    const p = join(process.env.DSH_HOME ?? '.', 'storages', 'provider-balance-exhausted.jsonl')
    if (!existsSync(p)) return []
    return readFileSync(p, 'utf8').split('\n').filter(l => l.trim() !== '')
      .map(l => { try { return JSON.parse(l) as BalanceExhaustedRecord } catch { return null } })
      .filter((r): r is BalanceExhaustedRecord => r !== null)
  } catch { return [] }
}
