# 集思（shence-jisi）—— 多模型思考 + v2 决策内核

神策（SHENCE）项目群 P3。DSH 插件:派单通道 + 多模型并行思考 + **模型效费比决策内核(v2)**。

## 定位与边界

- 集思是**通用件**:不认识任何业务(CTF 分/渗透目标等)。业务指标由宿主(runner)映射成**通用难度 0-100** 后再进集思。
- 适配器不是集思的职责:OpenAI 兼容 provider 路由(Kimi/智谱接入)独立成仓 **[@shence/dsh-compat](https://github.com/Zoot-running/shence-dsh-compat)**——它是集思的依赖项。
- **账本是信号,不是决策器**;决策 = 先验 × 在线加权贝叶斯 × Thompson 探索。

## 功能

- **派单通道**:`派活(工作描述, 模型?, 工具集?) → durable 子代理句柄`;`收结果(句柄) → 报告`;
- **按次指定模型 / 多模型并行(fanout)**:各路思路原样交回,信封 `[fanout:<id>] [model] [question]`;
- **v2 决策内核**(设计定稿 [METHODOLOGY/JISI-V2-DESIGN.md](METHODOLOGY/JISI-V2-DESIGN.md)):
  - 通用难度校准(宿主映射 + 终局 Beta 更新 + 归因门控);
  - 思路裁决 `jisi_adjudicate`(adopted/not-adopted/pending,终局对账,对数权重);
  - 宏观评价账本 ModelLedgerV2(加权 Beta + 三层收缩 + Thompson 采样 + 效费比四指标);
  - 公开基准先验(CyberGym/SEC-Bench/ExploitGym,k 按基准测量误差推导);
  - 契合度打分 `jisi_pick`(题目特征 × 模型能力向量,双维度候选 + 理由);
  - fanout 取数配置化(`fanoutSelection`,默认取目录排名上半);
- **综合归主 agent**:集思不做自动综合(不教 AI 做事),但裁决/排名给出有依据的候选。

## 为什么这么设计(要点)

1. **效费比问题不能用几十条本地样本解**:先验从公开基准借(安全域 CyberGym 等),本地只做贝叶斯更新;
2. **冷启动死循环**(没数据→不派→永无数据)由 Thompson 采样解决——探索量由后验方差自动调节,无 λ 旋钮;
3. **三层收缩**(单元格→题型→全局)让样本薄的格子向父层借力而不裸奔 0.5,空父层跳过不稀释;
4. **权重用对数难度函数**:难题胜不爆炸(难度 90→+1.53),送分题败最重但不抵消(难度 20→−0.81);
5. **归因门控**:context-insufficient/platform-issue 不进账本——归因错了,账本学错东西;
6. **以结果为导向**:不搞新颖率/去重指标;谁优谁劣终局结果说话。

## 配置

- `disabledModels?: string[]` —— 临时停用模型(目录/账本摘要/显式派单一律拒绝);
- `fanoutDefaultModels?: string[]` —— fanout 无题目特征时的便宜档兜底;
- `fanoutSelection?: { strategy?, fraction?, n?, min?, max? }` —— v2 取数策略(默认 top-fraction 0.5);
- `shrinkageStrength? / modelAliases? / voidModels?` —— v2 账本(收缩强度/改名继承/退役作废;改名继承由用户裁定);
- `kW? / kF?` —— 对数权重旋钮(默认 1);
- `priceOrder / priceTable / ledgerPath / seedLedgerPath` —— 计价与账本路径。

## 开发

```bash
npm test        # vitest(v2 内核/通道/计价)
npm run build   # esbuild → lib/index.js
```

历史账本迁移:旧 `jisi-model-ledger.json` 首启自动折入 v2(`jisi-model-ledger-v2.json`,qtype=misc、权重 1)。

## 关联

- 依赖:[@shence/dsh-compat](https://github.com/Zoot-running/shence-dsh-compat)(provider 路由 + 余额枯竭检测)
- 被依赖(软):[shence-hufu](https://github.com/Zoot-running/shence-hufu)(无本插件时回退 DSH 原生调度)
- 文档:[shence-junji](https://github.com/Zoot-running/shence-junji)
