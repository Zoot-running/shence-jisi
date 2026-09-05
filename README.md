# 集思（shence-jisi）—— 多模型思考

神策（SHENCE）项目群 P3。DSH 插件：派单通道 + 多模型并行思考。

## 功能

- **派单通道**：`派活(工作描述, 模型?, 工具集?) → durable 子代理句柄`；`收结果(句柄) → 报告`；
- **按次指定模型**：每次派单可覆盖模型（通道核心能力）；
- **多模型并行**：同一工作以不同模型参数派 N 次，各路思路**原样交回**；
- **综合归主 agent**：集思不做自动综合、不内置综合策略（不教 AI 做事）；
- **主 agent 自换模型**：经用户同意（复用 DSH permission-presets 门禁）；
- 模型清单从 DSH provider 配置动态读取，不内置。

## 边界

- 独立可运行，不依赖虎符（shence-hufu 反向软依赖本通道）；
- 不做槽位/队列/恢复——那是虎符的职责。

## 关联

- 被依赖（软）：[shence-hufu](https://github.com/Zoot-running/shence-hufu)（无本插件时回退 DSH 原生调度）
- 文档：[shence-docs](https://github.com/Zoot-running/shence-docs)
