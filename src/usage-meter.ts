/**
 * 用量计量器（provider 无关）：订阅宿主会话事件流，把每次 LLM 调用的 token
 * 用量追加到本地 sidecar（$DSH_HOME/storages/llm-usage.jsonl）。
 *
 * 与 llm-openai-compat 旧写入（只覆盖 compat 路由）的区别：本计量器挂在
 * `session/event` 事件总线上，主 agent 与所有子代理、任何 provider 路由
 * （native deepseek / compat kimi / compat zhipu）都覆盖（F9 根治）。
 *
 * 去重：每条记录带 (sid, seq)（会话 id + 事件序号）；会话重载/进程重启可能
 * 重放旧事件产生重复行，由 jisi_usage 读取端按 (sid, seq) 去重。
 * @module @shence/jisi/usage-meter
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

interface CallHeader {
  provider?: string
  model?: string
}

interface MeterState {
  /** 已消费事件序号（游标）。 */
  cursor: number
  /** 当前请求封套（request/header 事件更新）。 */
  header?: CallHeader
}

interface UsageData {
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  cacheReadTokens?: number
  totalTokens?: number
}

/** 从 request/header 事件解析 provider/model 封套。 */
function headerOf(event: SessionEvent): CallHeader | undefined {
  if (event.type !== 'request/header') return undefined
  const data = event.data as { header?: { config?: { provider?: unknown; model?: unknown } } }
  const config = data.header?.config
  if (config === undefined) return undefined
  const provider = typeof config.provider === 'string' ? config.provider : undefined
  const model = typeof config.model === 'string' ? config.model : undefined
  if (provider === undefined && model === undefined) return undefined
  return { provider, model }
}

/** 从 assistant/message 事件解析 usage（无 usage 返回 undefined）。 */
function usageOf(event: SessionEvent): UsageData | undefined {
  if (event.type !== 'assistant/message') return undefined
  const data = event.data as { usage?: UsageData }
  return data.usage
}

/**
 * 挂计量器：订阅全部会话的事件流，append sidecar 行。
 * 调用方（jisi apply）在插件装载时调用一次。
 */
export function attachUsageMeter(ctx: Context): void {
  const sidecar = (): string => join(process.env.DSH_HOME ?? '.', 'storages', 'llm-usage.jsonl')
  const states = new WeakMap<Session, MeterState>()

  const emit = (sid: string, seq: number, header: CallHeader, usage: UsageData): void => {
    if (header.provider === undefined && header.model === undefined) return
    try {
      const dir = join(sidecar(), '..')
      mkdirSync(dir, { recursive: true })
      appendFileSync(sidecar(), `${JSON.stringify({
        at: Date.now(),
        sid,
        seq,
        provider: header.provider,
        model: header.model,
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        reasoningTokens: usage.reasoningTokens ?? 0,
        cacheReadTokens: usage.cacheReadTokens ?? 0,
      })}\n`)
    } catch { /* 计量失败不影响主流程 */ }
  }

  ctx.on('session/event', (session: Session) => {
    let state = states.get(session)
    if (state === undefined) {
      state = { cursor: 0 }
      states.set(session, state)
    }
    const length = session.seq
    for (let index = state.cursor; index < length; index++) {
      const event = session.eventAt(SessionSeq(index))
      if (event === undefined) break
      state.cursor = index + 1
      const header = headerOf(event)
      if (header !== undefined) {
        state.header = header
        continue
      }
      const usage = usageOf(event)
      if (usage !== undefined && state.header !== undefined) {
        emit(session.id, Number(event.seq), state.header, usage)
      }
    }
  })
}
