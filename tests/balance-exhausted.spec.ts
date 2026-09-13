/**
 * L0：llm-openai-compat F35 余额枯竭检测。
 * 402/余额文案 → BALANCE_EXHAUSTED 错误 + sidecar 落盘（隔离信道）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isBalanceExhausted, readBalanceExhausted, recordBalanceExhausted } from '../packages/llm-openai-compat/src/balance-guard.ts'

let tmp: string
function setupHome(): void {
  tmp = mkdtempSync(join(tmpdir(), 'jisi-balance-'))
  mkdirSync(join(tmp, 'storages'), { recursive: true })
  process.env.DSH_HOME = tmp
  process.env.TEST_MOCK_KEY = 'sk-test-key-123456'
}
afterEach(() => {
  vi.unstubAllGlobals()
  if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true })
  delete process.env.DSH_HOME
  delete process.env.TEST_MOCK_KEY
})

describe('F35 balance exhaustion', () => {
  it('402 + insufficient balance → 判定余额枯竭', () => {
    expect(isBalanceExhausted(402, '{"error":{"message":"Insufficient Balance"}}')).toBe(true)
    expect(isBalanceExhausted(429, '{"error":{"code":"1113","message":"余额不足"}}')).toBe(true)
    expect(isBalanceExhausted(401, 'quota exceeded')).toBe(true)
  })

  it('500 / 非余额文案 → 不判定', () => {
    expect(isBalanceExhausted(500, 'server exploded')).toBe(false)
    expect(isBalanceExhausted(402, 'rate limit')).toBe(false)
  })

  it('record + read sidecar 往返', () => {
    setupHome()
    recordBalanceExhausted('kimi-gw', 'kimi-k3', 'Insufficient Balance', 402)
    const recs = readBalanceExhausted()
    expect(recs.length).toBe(1)
    expect(recs[0]).toMatchObject({ provider: 'kimi-gw', model: 'kimi-k3', status: 402 })
    expect(existsSync(join(tmp, 'storages', 'provider-balance-exhausted.jsonl'))).toBe(true)
  })
})
