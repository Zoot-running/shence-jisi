/**
 * 集思 DSH 插件入口。
 * apply(ctx)：把真实宿主能力（ctx.subagents / provider 配置 / 权限门禁）
 * 绑定到 JisiChannel 并注册模型可见工具（delegate/fanout/listModels）。
 *
 * 注意：本文件依赖宿主 API（@deepseek-ai/dsh-*），其精确形状以
 * dev checkout（最新版）为准——clone 构建完成后按实际签名补齐并
 * 恢复真实 Context 类型。当前占位类型仅保证仓库独立 typecheck。
 * @module @shence/jisi
 */

type HostContext = unknown

export const name = 'shence-jisi'

export interface Config {
  /** 模型可见工具名（默认 jisi）。 */
  toolName?: string
}

export function apply(ctx: HostContext, config: Config = {}): void {
  // TODO(dev-checkout): 绑定 ctx.subagents（continuable 派单 + agentOptions.model 按次覆盖）
  //   → Spawner；绑定 Collector（settle 等待）；listModels 读 provider 配置；
  //   switchMainModel 经 permission-presets 门禁。
  // 契约与核心逻辑见 src/channel.ts（不依赖宿主，L0 已可测）。
  void config
  void ctx
}
