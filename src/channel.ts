/**
 * 集思通道核心（ADR-002 契约实现）。
 * 纯逻辑 + 注入接口：delegate 校验、fanout 扇出记账、collect 原样交回。
 * 不做综合、不排序、不合并——综合判断归主 agent（不教 AI 做事）。
 * @module @shence/jisi/channel
 */

import type {
  Collector,
  DispatchOptions,
  DispatchResult,
  ModelInfo,
  MainModelSwitcher,
  Report,
  Spawner,
  WorkItem,
} from './types.ts'

export class InvalidWorkError extends Error {
  constructor(reason: string) {
    super(`jisi: invalid work: ${reason}`)
    this.name = 'InvalidWorkError'
  }
}

/** 校验工作描述：prompt 非空且为 string。 */
export function assertValidWork(work: WorkItem): void {
  if (typeof work.prompt !== 'string' || work.prompt.trim().length === 0) {
    throw new InvalidWorkError('prompt must be a non-empty string')
  }
  if (work.workdir !== undefined && typeof work.workdir !== 'string') {
    throw new InvalidWorkError('workdir must be a string')
  }
  if (work.tools !== undefined && (!Array.isArray(work.tools) || work.tools.some(t => typeof t !== 'string'))) {
    throw new InvalidWorkError('tools must be an array of strings')
  }
}

/** 模型清单目录（宿主 LLM 适配器动态读取；测试注入 stub）。 */
export interface ModelCatalog {
  listProviders(): Array<{ id: string }>
  listModels(providerId: string): Promise<Array<{ id: string; provider: string }>>
}

/**
 * 按模型名反查宿主 provider。只有 model 没有 provider 的派单
 * （fanout、按次模型）必须先解析路由，否则模型会被误送到默认 provider。
 * 未找到返回 undefined（调用方保持默认路由）。
 */
export async function resolveProviderOfModel(catalog: ModelCatalog, modelId: string): Promise<string | undefined> {
  for (const provider of catalog.listProviders()) {
    for (const info of await catalog.listModels(provider.id)) {
      if (info.id === modelId) return info.provider
    }
  }
  return undefined
}

/**
 * 集思通道。
 * 依赖注入：spawner/collector/models/switcher 由宿主插件在 apply() 时绑定；
 * L0 测试注入 stub。
 */
export class JisiChannel {
  constructor(
    private readonly spawner: Spawner,
    private readonly collector: Collector,
    private readonly models: () => ModelInfo[] | Promise<ModelInfo[]>,
    private readonly switcher?: MainModelSwitcher,
  ) {}

  /** 派活：校验后经注入 spawner 派单。 */
  delegate(work: WorkItem, opts: DispatchOptions = {}): DispatchResult {
    assertValidWork(work)
    return this.spawner.spawn(work, opts)
  }

  /** 收结果：原样返回注入 collector 的报告。 */
  collect(result: DispatchResult | { ref: { id: string } }): Promise<Report> {
    return this.collector.collect({ id: result.ref.id })
  }

  /**
   * 多模型并行：同一 work 以不同 model 各派一次。
   * 全部 settle 后返回各报告（原样、不综合）。
   * model 列表空 → 返回 []。
   */
  async fanout(work: WorkItem, models: readonly string[], opts: DispatchOptions = {}): Promise<Report[]> {
    assertValidWork(work)
    const dispatches = models.map(model => this.delegate(work, { ...opts, model }))
    return Promise.all(dispatches.map(d => d.report))
  }

  /** 模型清单（宿主 provider 配置动态读取）。 */
  async listModels(): Promise<ModelInfo[]> {
    return await this.models()
  }

  /** 主 agent 自换模型（需宿主门禁在 apply() 侧实现）。 */
  async switchMainModel(model: string): Promise<void> {
    if (!this.switcher) throw new Error('jisi: main-model switching is not supported by the host')
    await this.switcher(model)
  }
}
