# 集思 v2 决策内核设计(第 0/1/2 层定稿)

> 2026-09-14 与用户逐轮讨论定稿。实现时以本文件为准,不再凭记忆。
> 核心立场:以结果为导向;账本是信号不是决策器;决策 = 先验 × 在线加权贝叶斯 × Thompson 探索;
> 能删的参数就删(λ 已删);必须有的旋钮全部进配置。

## 第 0 层:通用问题难度评分 + 思路裁决与归因

### 0.1 通用难度(0-100)
- 集思不认业务分。宿主把业务指标映射成难度**初值**(CTF 宿主: `难度 = 100·(1 − e^(−分值/600))`,映射表宿主可换);
- 在线校准: `难度 = 100 × (1 − 平滑成功率)`,Beta 后验(初值折算伪计数);
- **归因门控**: context-insufficient / platform-issue 的终局不更新难度;
- 难度住在题目画像,每题一条(先验/观测/后验)。

### 0.2 思路裁决词汇(仅三个)
| 裁决 | 账本动作 |
|---|---|
| adopted | 思路模型 idea 维度记正(权重见 0.3) |
| not-adopted | 0(可选一句话理由) |
| pending | 0;不自动降级(裁决不全/不及时是主模型的问题,分数不动) |

- 机制: `jisi_adjudicate`(一批一调,主 agent 用);
- **重复/新颖率/superseded 全部不做**(模型不知道别的模型存在;谁优谁劣终局结果说话)。

### 0.3 终局对账(采纳后)
- 采纳+题终胜:不重复加分(采纳时已加);
- 采纳+题终败:按归因分流:
  - `approach-dead-end` → 思路模型 idea **−w_f**(权重见下);
  - `model-weak` → 思路模型不扣,执行模型 execution 维度记负(同权重函数);
  - `context-insufficient` → 谁都不扣,缺口进画像 `contextGaps`(下次 fanout 自动补);
  - `platform-issue` → 谁都不扣(需留证)。
- 归因**两级判定**:执行者终态报告提议(现场视野),主 agent 在 xiaochang_report 终裁(全局视野)。

### 0.4 权重函数(对数,难度为自变量)
- 胜: `+k_w · ln(1 + 难度/25)`
- 败(approach-dead-end): `−k_f · ln(1 + 25/难度)`
- 性质: 难题胜不爆炸(难度90→1.53),送分题败最重但不倾家荡产(难度20→0.81);
  解 90 难题(+1.53)+错 20 送分题(−0.81)=+0.72,不抵消。
- k_w = k_f = 1 起步(全局旋钮)。

## 第 1 层:宏观评价方案

1. **评估矩阵**: 模型 × 维度(execution/idea) × 题型(web/crypto/pwn/rev/取证/misc) × 难度桶(0-40/40-70/70-100);
   **三层收缩**(partial pooling): 单元格 → 题型 → 全局,样本少自动向父层借力。
2. **四指标**: 加权终胜率(idea)/ 加权首胜率(execution)/ **¥/难度点** / **难度点/分钟**。
   难度一律 0-100 通用尺;业务分只在宿主换算层出现。
3. **聚合**: 加权 Beta 后验(权重=0.4 对数函数;context/platform 不入账)。
4. **决策器**: **Thompson 采样**(每次从后验抽一个实现)——无 λ 旋钮,探索量自动。
5. **时效**: 无时间衰减;仅退役作废;同一服务改名继承与否由**用户裁定**。
6. **输出**: `jisi_model_report` v2(后验胜率+样本数+两条效费比+作废标注)。

## 第 2 层:先验与契合度

### 2.1 公开基准 → Beta 先验
- 源(分域+通用): CyberGym / ExploitGym / SEC-Bench Pro / GPQA / SWE-bench / Terminal-Bench;
  映射到 (模型×维度×题型) 格子;只做 like-for-like,带出处记录(source+date)。
- 折算: `a0 = (s/100)·k`, `b0 = (1−s/100)·k`;
- **k 由公式推导,不是常数**: `k = priorDiscount × 1/(4·SE²)`,
  SE = √(p(1−p)/n_tasks)(基准自身测量误差); `priorDiscount = 0.25` 是全局配置(域偏移折扣,唯一主观参数)。
- 无公开数据的格子: Beta(1,1) 均匀,探索交给 Thompson。

### 2.2 题目特征向量
- 静态: 题型 / 难度初值(0.1 映射)/ 附件有无·形式 / flag 格式 / 容器形态 / 宿主分;
- 动态: 校准后难度 / 已试模型×结果×归因 / deadEnds 数 / 未走分叉数 / contextGaps / 尝试次数 / 剩余预算。

### 2.3 契合度与 jisi_pick
- 能力向量: 该题型三桶后验按本题难度线性插值 → Thompson 抽一次;
- 三层收缩自动借力;缺口(contextGaps)是题的,不惩罚模型;
- `jisi_pick(code)` 输出: idea/execution 两维度各 top-N + 理由(后验来源/先验来源/探索贡献/预计成本与耗时)。

### 2.4 fanout/派单取数(配置化)
```yaml
fanoutSelection:
  strategy: top-fraction   # top-fraction | top-n | all
  fraction: 0.5            # 默认 idea 侧取目录排名上半(6 模型→3)
  min: 1
  max: 0                   # 0 = 不封顶
```
- idea 侧默认 top-fraction 0.5;卡题/末段升级由第 3 层规则显式覆盖;
- execution 侧独立配置,默认 top-n n=1;失败升级走第 3 层;
- 主 agent 仍掌决策权,pick 只给候选+理由。

## 第 3 层:失败升级路径 + 二次思路带入(定稿)

### 3.1 每题状态机(宿主 runner 持有)
```
R1: fanout(默认一半模型)→ 派单(top-1 执行)
    思路死亡 = approach-dead-end 终局
    ── 已死思路/已征集思路 ≥ 0.5(阈值可配)──▶ R2
R2: 二次 fanout —— 模型集 = R1 模型 ∪ 新增模型(直接加模型增添信息)
    上下文带入: R1 全部思路(死的+仍在跑的)+ 死路清单 + contextGaps + 归因
    派单 prompt 同样自带 R1 思路与失败经验
    全部模型征集穷尽且思路全死 → 判死(兵力≥3 个不同思路)
hint: 主 agent 专属单点(机制强制), 每题上限 1
末段(≤60min): 有 hard 未破 → 直接全模型档 R2(覆盖)
```

### 3.2 归因联动(仅两条)
- `approach-dead-end` → 升级思路(R2);
- `context-insufficient` → 补上下文原思路重派;
- `model-weak` / `platform-issue` → 只记账不触发(**执行模型出问题零先例**:
  XBOW 088/092 十四路 flash+glm 同族思路全死=思路死非模型弱; 换执行模型路径已删)。

### 3.3 R2 二次带入(自动拼装)
- prompt 模板: [题目+画像] + [R1 全部思路×归因(死的+在跑的)] + [死路清单] + [contextGaps]
  + 提问"已知以上死路与缺口后,还有哪些没试过的方向";
- 语义固化: "怎么解" → "已知 X/Y 之后还有什么方向"。

### 3.4 hint 单点强制
- `xiaochang_hint` 守卫: 仅主 agent(战役 setup 者)可调, 执行者调用响亮拒绝(防多执行者同时看乱)。

### 3.5 配置
```yaml
escalation:
  deadIdeaRatioThreshold: 0.5   # 已死思路/已征集思路 ≥ 此值 → R2
  refanoutModelMode: add        # R2 加模型(不排除已试)
  refanoutRoundsMax: 2          # 征集穷尽轮数(全部模型问过一遍为止)
  minTroopsBeforeFail: 3        # 判死兵力下限
  endgameMinutes: 60            # 末段阈值
```

## 待办(记录在案,后续迭代)
- **预算约束降权**: 契合度不接预算;预算裁决放宿主调度层,接口留 `budgetBand`。
