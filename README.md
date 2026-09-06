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
- 文档：[shence-junji](https://github.com/Zoot-running/shence-junji)

## 实现状态

- ✅ 通道契约（ADR-002）：`src/channel.ts` 纯逻辑 + 13 项 L0 测试
- ✅ 宿主绑定：`src/index.ts` + `src/service.ts` — `ctx.jisi` 服务（delegate/fanout/listModels，按次指定模型）
- ✅ 多供应商接入：`packages/llm-openai-compat`（OpenAI 兼容适配器，Kimi/智谱实测通过）
- ✅ L1 集成验证：`packages/probe`（jisi_probe 工具）在 dev 实例实测——glm-4.5-air/kimi-k2.6 子代理 PONG 全通
- ✅ L1 实测：delegate（glm-4.5-air→PONG）、fanout（kimi+glm 并行）、listModels（3 供应商 6 模型）全通
- ⏳ v1.1 遗留：后台 continuable 服务端收结果（父 agent 侧 settle 通知已天然可用）、主 agent 自换模型、fanout 供应商限流重试（glm 并发偶发空结果）

## 开发循环（dev 实例）

```
pnpm build && pnpm test            # 仓库内
dsh plugin --profile headless rm/add file:<repo>   # 装进 dev profile（file: 拷贝，改动需重装）
KIMI_API_KEY=... ZHIPU_API_KEY=... dsh --profile headless "调用 jisi_probe ..."
```
