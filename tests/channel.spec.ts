/**
 * L0 单元测试：通道契约核心（stub 注入，不依赖 DSH 宿主）。
 * 覆盖：delegate 校验、fanout 扇出与模型透传、collect 原样交回、无综合。
 */
import { describe, expect, it, vi } from 'vitest'
import { InvalidWorkError, JisiChannel, assertValidWork, resolveProviderOfModel } from '../src/channel.ts'
import type { Collector, DispatchOptions, MainModelSwitcher, ModelCatalog, ModelInfo, Report, Spawner, WorkItem } from '../src/types.ts'

function makeReport(id: string, status: Report['status'] = 'completed'): Report {
  return { status, text: `answer-from-${id}` }
}

function stubSpawner(): { spawner: Spawner; calls: Array<{ work: WorkItem; opts: DispatchOptions }> } {
  const calls: Array<{ work: WorkItem; opts: DispatchOptions }> = []
  const spawner: Spawner = {
    spawn(work, opts) {
      calls.push({ work, opts })
      const ref = { id: `child-${calls.length}` }
      return {
        ref,
        report: Promise.resolve(makeReport(ref.id)),
      }
    },
  }
  return { spawner, calls }
}

function stubCollector(): { collector: { collect: ReturnType<typeof vi.fn> } } {
  const collect = vi.fn(async (ref: { id: string }) => makeReport(ref.id))
  return { collector: { collect } }
}

function channel(opts: {
  spawner?: Spawner
  collector?: Collector
  models?: () => ModelInfo[]
  switcher?: MainModelSwitcher
} = {}) {
  const { spawner, calls } = stubSpawner()
  const { collector } = stubCollector()
  const models = (): ModelInfo[] => [{ id: 'm1', provider: 'p' }]
  const ch = new JisiChannel(opts.spawner ?? spawner, opts.collector ?? collector, opts.models ?? models, opts.switcher)
  return { ch, calls, collector }
}

describe('assertValidWork', () => {
  it('rejects empty prompt', () => {
    expect(() => assertValidWork({ prompt: '' })).toThrow(InvalidWorkError)
    expect(() => assertValidWork({ prompt: '   ' })).toThrow(InvalidWorkError)
  })
  it('rejects non-string prompt', () => {
    expect(() => assertValidWork({ prompt: 1 as unknown as string })).toThrow(InvalidWorkError)
  })
  it('rejects non-array tools', () => {
    expect(() => assertValidWork({ prompt: 'x', tools: 'nope' as unknown as string[] })).toThrow(InvalidWorkError)
  })
  it('accepts a minimal valid work', () => {
    expect(() => assertValidWork({ prompt: 'do the thing' })).not.toThrow()
  })
})

describe('resolveProviderOfModel', () => {
  const catalog: ModelCatalog = {
    listProviders: () => [{ id: 'kimi-official' }, { id: 'zhipu-official' }],
    listModels: vi.fn(async (providerId: string) =>
      providerId === 'kimi-official'
        ? [{ id: 'kimi-k2.6', provider: 'kimi-official' }]
        : [{ id: 'glm-4.5-air', provider: 'zhipu-official' }, { id: 'glm-4.6', provider: 'zhipu-official' }],
    ),
  }

  it('resolves a model to its home provider', async () => {
    await expect(resolveProviderOfModel(catalog, 'glm-4.5-air')).resolves.toBe('zhipu-official')
    await expect(resolveProviderOfModel(catalog, 'kimi-k2.6')).resolves.toBe('kimi-official')
  })

  it('returns undefined for unknown models', async () => {
    await expect(resolveProviderOfModel(catalog, 'nonexistent')).resolves.toBeUndefined()
  })
})

describe('JisiChannel.delegate', () => {
  it('passes work and options through to spawner', () => {
    const { ch, calls } = channel()
    const work = { prompt: 'solve A' }
    const res = ch.delegate(work, { model: 'gpt-x' })
    expect(res.ref.id).toBe('child-1')
    expect(calls[0]!.work).toEqual(work)
    expect(calls[0]!.opts.model).toBe('gpt-x')
  })
  it('rejects invalid work before spawning', () => {
    const { ch, calls } = channel()
    expect(() => ch.delegate({ prompt: '' })).toThrow(InvalidWorkError)
    expect(calls).toHaveLength(0)
  })
})

describe('JisiChannel.fanout', () => {
  it('dispatches once per model with per-dispatch model override', async () => {
    const { ch, calls } = channel()
    const reports = await ch.fanout({ prompt: 'hard problem' }, ['m-a', 'm-b', 'm-c'])
    expect(calls).toHaveLength(3)
    expect(calls.map(c => c.opts.model)).toEqual(['m-a', 'm-b', 'm-c'])
    expect(reports.map(r => r.text)).toEqual(['answer-from-child-1', 'answer-from-child-2', 'answer-from-child-3'])
  })
  it('returns original reports verbatim (no synthesis)', async () => {
    const { ch } = channel()
    const reports = await ch.fanout({ prompt: 'q' }, ['m-a'])
    expect(reports[0]).toEqual({ status: 'completed', text: 'answer-from-child-1' })
  })
  it('returns [] for empty model list', async () => {
    const { ch, calls } = channel()
    expect(await ch.fanout({ prompt: 'q' }, [])).toEqual([])
    expect(calls).toHaveLength(0)
  })
})

describe('JisiChannel.collect / switchMainModel / listModels', () => {
  it('collect delegates to injected collector with the ref id', async () => {
    const { ch, collector } = channel()
    const res = ch.delegate({ prompt: 'x' })
    await ch.collect(res)
    expect(collector.collect).toHaveBeenCalledWith({ id: 'child-1' })
  })
  it('switchMainModel rejects when host has no switcher', async () => {
    const { ch } = channel()
    await expect(ch.switchMainModel('m')).rejects.toThrow(/not supported/)
  })
  it('switchMainModel forwards when switcher injected', async () => {
    const switcher = vi.fn(async () => {})
    const { ch } = channel({ switcher })
    await ch.switchMainModel('m-x')
    expect(switcher).toHaveBeenCalledWith('m-x')
  })
  it('listModels reads from injected provider config', async () => {
    const { ch } = channel()
    expect(await ch.listModels()).toEqual([{ id: 'm1', provider: 'p' }])
  })
})
