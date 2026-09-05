/**
 * 集思通道契约类型（ADR-002）。
 * 与宿主实现解耦：channel 核心只依赖注入接口，便于 L0 单元测试与移植。
 * @module @shence/jisi/types
 */

/** 自包含工作描述。 */
export interface WorkItem {
  /** 自包含工作描述（唯一必填）。 */
  prompt: string
  /** 可选工作目录。 */
  workdir?: string
  /** 可选工具过滤（缺省继承宿主默认）。 */
  tools?: string[]
}

/** 派单选项（按次指定模型是通道的核心能力）。 */
export interface DispatchOptions {
  /** 按次指定模型；缺省 = 宿主默认模型。 */
  model?: string
  /** 可选 provider 覆盖。 */
  provider?: string
  /** 后台执行（durable 子代理）；默认 true。 */
  background?: boolean
}

/** durable 子代理引用。 */
export interface ChildRef {
  readonly id: string
}

export type ReportStatus = 'completed' | 'failed' | 'blocked'

/** 收结果报告：子代理最终答复，原样返回。 */
export interface Report {
  readonly status: ReportStatus
  readonly text: string
}

/** 派单结果：ref + 同异步获取报告的句柄。 */
export interface DispatchResult {
  readonly ref: ChildRef
  /** settle 后解析为 Report；后台派单时立即返回该 Promise。 */
  readonly report: Promise<Report>
}

/** 模型条目（从宿主 provider 配置动态读取）。 */
export interface ModelInfo {
  readonly id: string
  readonly provider: string
}

/** 注入的派活原语（L0 测试用 stub 实现）。 */
export interface Spawner {
  spawn(work: WorkItem, opts: DispatchOptions): DispatchResult
}

/** 注入的收集原语。 */
export interface Collector {
  collect(ref: ChildRef): Promise<Report>
}

/** 注入的主模型切换原语（宿主不支持时可为 undefined）。 */
export type MainModelSwitcher = (model: string) => Promise<void> | void
