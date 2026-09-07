// src/index.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";

// src/model-ledger.ts
var ModelLedger = class _ModelLedger {
  models = /* @__PURE__ */ new Map();
  static fromJSON(data) {
    const ledger = new _ModelLedger();
    const models = data?.models ?? {};
    for (const [model, dims] of Object.entries(models)) {
      for (const [dimension, keys] of Object.entries(dims?.dimensions ?? {})) {
        for (const [key, record] of Object.entries(keys)) {
          if (record === void 0 || typeof record.attempts !== "number") continue;
          ledger.bucket(model, dimension, key).attempts = record.attempts;
          ledger.bucket(model, dimension, key).wins = record.wins;
        }
      }
    }
    return ledger;
  }
  toJSON() {
    const models = {};
    for (const [model, dims] of this.models) {
      const dimensions = {};
      for (const [dimension, keys] of dims) {
        for (const [key, record] of keys) dimensions[dimension] = { ...dimensions[dimension] ?? {}, [key]: record };
      }
      models[model] = { dimensions };
    }
    return { models };
  }
  bucket(model, dimension, key) {
    const dims = this.models.get(model) ?? /* @__PURE__ */ new Map();
    this.models.set(model, dims);
    const keys = dims.get(dimension) ?? /* @__PURE__ */ new Map();
    dims.set(dimension, keys);
    const existing = keys.get(key);
    if (existing !== void 0) return existing;
    const created = { attempts: 0, wins: 0 };
    keys.set(key, created);
    return created;
  }
  /** 记一局：某模型在（维度, 细分键）上的一次结果（win=true 为胜）。 */
  record(model, dimension, key, win) {
    const bucket = this.bucket(model, dimension, key);
    bucket.attempts += 1;
    if (win) bucket.wins += 1;
  }
  /** 平滑胜率（Laplace +1/+2）；无记录 = 0.5。 */
  rate(model, dimension, key) {
    const bucket = this.models.get(model)?.get(dimension)?.get(key);
    if (bucket === void 0 || bucket.attempts === 0) return 0.5;
    return (bucket.wins + 1) / (bucket.attempts + 2);
  }
  /** 按（维度, 细分键）给候选模型排序：胜率高者前；同分（<1%）按价格序。 */
  rank(dimension, key, candidates, priceOrder = []) {
    const priceOf = (model) => priceOrder.includes(model) ? priceOrder.indexOf(model) : priceOrder.length;
    return [...candidates].sort((a, b) => {
      const ra = this.rate(a, dimension, key);
      const rb = this.rate(b, dimension, key);
      if (Math.abs(ra - rb) > 0.01) return rb - ra;
      return priceOf(a) - priceOf(b);
    });
  }
  /** 人读摘要（jisi_model_report 工具输出）。 */
  summary() {
    const out = [];
    for (const [model, dims] of this.models) {
      for (const [dimension, keys] of dims) {
        for (const [key, record] of keys) {
          out.push({ model, dimension, key, attempts: record.attempts, wins: record.wins, rate: this.rate(model, dimension, key) });
        }
      }
    }
    return out.sort((a, b) => b.rate - a.rate);
  }
};

// src/service.ts
import { settleRun } from "@deepseek-ai/dsh-subagent";

// src/channel.ts
var InvalidWorkError = class extends Error {
  constructor(reason) {
    super(`jisi: invalid work: ${reason}`);
    this.name = "InvalidWorkError";
  }
};
function assertValidWork(work) {
  if (typeof work.prompt !== "string" || work.prompt.trim().length === 0) {
    throw new InvalidWorkError("prompt must be a non-empty string");
  }
  if (work.workdir !== void 0 && typeof work.workdir !== "string") {
    throw new InvalidWorkError("workdir must be a string");
  }
  if (work.tools !== void 0 && (!Array.isArray(work.tools) || work.tools.some((t) => typeof t !== "string"))) {
    throw new InvalidWorkError("tools must be an array of strings");
  }
}
async function resolveProviderOfModel(catalog, modelId) {
  for (const provider of catalog.listProviders()) {
    for (const info of await catalog.listModels(provider.id)) {
      if (info.id === modelId) return info.provider;
    }
  }
  return void 0;
}
var JisiChannel = class {
  constructor(spawner, collector, models, switcher) {
    this.spawner = spawner;
    this.collector = collector;
    this.models = models;
    this.switcher = switcher;
  }
  /** 派活：校验后经注入 spawner 派单。 */
  delegate(work, opts = {}) {
    assertValidWork(work);
    return this.spawner.spawn(work, opts);
  }
  /** 收结果：原样返回注入 collector 的报告。 */
  collect(result) {
    return this.collector.collect({ id: result.ref.id });
  }
  /**
   * 多模型并行：同一 work 以不同 model 各派一次。
   * 全部 settle 后返回各报告（原样、不综合）。
   * model 列表空 → 返回 []。
   */
  async fanout(work, models, opts = {}) {
    assertValidWork(work);
    const dispatches = models.map((model) => this.delegate(work, { ...opts, model }));
    return Promise.all(dispatches.map((d) => d.report));
  }
  /** 模型清单（宿主 provider 配置动态读取）。 */
  async listModels() {
    return await this.models();
  }
  /** 主 agent 自换模型（需宿主门禁在 apply() 侧实现）。 */
  async switchMainModel(model) {
    if (!this.switcher) throw new Error("jisi: main-model switching is not supported by the host");
    await this.switcher(model);
  }
};

// src/service.ts
function textOfBlocks(output) {
  if (output === void 0) return "";
  return output.filter((b) => b.type === "text").map((b) => b.type === "text" ? b.text : "").join("");
}
async function effortSupported(llm, llmProvider, model, effort) {
  if (llmProvider === void 0 || model === void 0) return false;
  try {
    const info = await llm.resolveModelInfo(llmProvider, model);
    return info.reasoning?.efforts?.some((e) => String(e.id) === effort) ?? false;
  } catch {
    return false;
  }
}
async function modelListedOnProvider(catalog, provider, model) {
  try {
    for (const info of await catalog.listModels(provider)) {
      if (info.id === model) return true;
    }
  } catch {
  }
  return false;
}
function reportStatus(stopReason) {
  if (stopReason === "completed") return "completed";
  if (stopReason === "aborted" || stopReason === "error") return "failed";
  return "completed";
}
function createJisiService(ctx, provider, modelLedger, onLedgerChange) {
  let currentParent;
  const continuables = /* @__PURE__ */ new Map();
  const spawner = {
    spawn(work, opts) {
      const parent = currentParent;
      if (parent === void 0) {
        throw new Error("jisi: delegate requires a parent Agent (pass it explicitly to the service)");
      }
      const prompt = [{ type: "text", text: work.prompt }];
      const report = (async () => {
        const agentOptions = {};
        if (opts.model !== void 0) agentOptions.model = opts.model;
        let llmProvider = opts.provider;
        if (llmProvider === void 0 && opts.model !== void 0) {
          llmProvider = await resolveProviderOfModel(ctx.llm, opts.model);
          if (llmProvider === void 0) {
            return { status: "failed", text: `[no-provider-for-model] \u6A21\u578B ${opts.model} \u672A\u51FA\u73B0\u5728\u4EFB\u4F55\u5DF2\u6CE8\u518C provider \u7684\u76EE\u5F55\u4E2D\uFF1B\u62D2\u7EDD\u6D3E\u5355\uFF08\u4E0D\u9759\u9ED8\u56DE\u843D\u9ED8\u8BA4\u8DEF\u7531\uFF09` };
          }
        }
        if (llmProvider !== void 0 && opts.model !== void 0) {
          if (!await modelListedOnProvider(ctx.llm, llmProvider, opts.model)) {
            return { status: "failed", text: `[model-not-on-provider] provider ${llmProvider} \u7684\u76EE\u5F55\u4E2D\u6CA1\u6709\u6A21\u578B ${opts.model}\uFF1B\u62D2\u7EDD\u6D3E\u5355` };
          }
        }
        if (llmProvider !== void 0) agentOptions.provider = llmProvider;
        if (opts.reasoningEffort !== void 0) {
          const supported = await effortSupported(ctx.llm, llmProvider, opts.model, opts.reasoningEffort);
          if (supported) {
            agentOptions.reasoningEffort = opts.reasoningEffort;
          }
        }
        if (opts.background === true) {
          try {
            const started = await ctx.subagents.startContinuable({
              provider,
              label: "jisi-delegate",
              request: {
                prompt,
                parent,
                ...Object.keys(agentOptions).length > 0 ? { agentOptions } : {}
              },
              signal: new AbortController().signal
            });
            continuables.set(started.childId, parent);
            return { status: "completed", text: "" };
          } catch (error) {
            return { status: "failed", text: `[continuable-start-failed] ${String(error)}` };
          }
        }
        const run = await ctx.subagents.start(provider, {
          label: "jisi-delegate",
          prompt,
          parent,
          signal: new AbortController().signal,
          ...Object.keys(agentOptions).length > 0 ? { agentOptions } : {}
        });
        const result = await run.result;
        void settleRun(run);
        const output = textOfBlocks(result.output);
        const diagnostic = result.stopReason !== "completed" && result.diagnostic !== void 0 && result.diagnostic !== "" ? `
[diagnostic] ${result.diagnostic}` : "";
        return {
          status: reportStatus(result.stopReason),
          text: output + diagnostic
        };
      })();
      return { ref: { id: "one-shot" }, report };
    }
  };
  const collector = {
    collect() {
      return Promise.resolve({ status: "failed", text: "jisi: collect is embedded in the dispatch promise" });
    }
  };
  const models = async () => {
    const out = [];
    for (const provider2 of ctx.llm.listProviders()) {
      const infos = await ctx.llm.listModels(provider2.id);
      for (const info of infos) {
        out.push({ id: info.id, provider: info.provider });
      }
    }
    return out;
  };
  const channel = new JisiChannel(spawner, collector, models);
  const withParent = (parent, run) => {
    currentParent = parent;
    try {
      return run();
    } finally {
      currentParent = void 0;
    }
  };
  return {
    delegate(parent, work, opts = {}) {
      return withParent(parent, () => channel.delegate(work, opts));
    },
    fanout(parent, work, models2, opts = {}) {
      return withParent(parent, () => channel.fanout(work, models2, opts));
    },
    listModels: () => channel.listModels(),
    async continue(parent, childId, message) {
      await ctx.subagents.sendMessage(
        parent,
        childId,
        [{ type: "text", text: message }],
        { signal: new AbortController().signal }
      );
    },
    ledger: {
      record(model, dimension, key, win) {
        modelLedger.record(model, dimension, key, win);
        onLedgerChange();
      },
      rank: (dimension, key, candidates, priceOrder) => modelLedger.rank(dimension, key, candidates, priceOrder),
      summary: () => modelLedger.summary()
    }
  };
}

// src/index.ts
var name = "shence-jisi";
var inject = ["subagents", "llm", "tools"];
function isBeijingPeak(at) {
  const d = new Date(at ?? Date.now());
  const beijing = new Date(d.getTime() + 8 * 36e5);
  const day = beijing.getUTCDay();
  if (day === 0 || day === 6) return false;
  const minutes = beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
  return minutes >= 9 * 60 && minutes < 12 * 60 || minutes >= 14 * 60 && minutes < 18 * 60;
}
function apply(ctx, config = {}) {
  const provider = config.provider ?? "spawn";
  const ledgerPath = config.ledgerPath ?? join(process.env.DSH_HOME ?? ".", "storages", "jisi-model-ledger.json");
  const priceOrder = config.priceOrder ?? ["glm-5.3-flash", "glm-4.5-air", "glm-4.6", "glm-4.7", "deepseek-v4-flash", "kimi-k2.6", "kimi-k2.7-code", "glm-5.3", "deepseek-v4-pro", "kimi-k2.7-code-highspeed", "kimi-k3"];
  const priceTable = config.priceTable ?? {
    // 单价（CNY / 1M token）。2026-09-08 按官方定价页校准：
    //  - Kimi：platform.kimi.com/docs/pricing/{chat-k3,chat-k27-code,chat-k26}
    //  - DeepSeek：api-docs.deepseek.com/zh-cn/quick_start/pricing/（峰/谷双价，谷=半价；高峰=周一至五 9-12/14-18）
    //  - GLM：仍为估算（待智谱平台价格页核对，见 shence-junji VALIDATION/L2-MODEL-CATALOG-2026-09.md）
    "deepseek-v4-flash": { input: 3, output: 9, cacheRead: 0.1, idle: { input: 1.5, output: 4.5, cacheRead: 0.05 } },
    "deepseek-v4-pro": { input: 9, output: 27, cacheRead: 0.3, idle: { input: 4.5, output: 13.5, cacheRead: 0.15 } },
    "deepseek-v4-flash-vision-exp": { input: 3, output: 9, cacheRead: 0.1, idle: { input: 1.5, output: 4.5, cacheRead: 0.05 } },
    "kimi-k3": { input: 20, output: 100, cacheRead: 2 },
    "kimi-k2.6": { input: 6.5, output: 27, cacheRead: 1.1 },
    "kimi-k2.7-code": { input: 6.5, output: 27, cacheRead: 1.3 },
    "kimi-k2.7-code-highspeed": { input: 13, output: 54, cacheRead: 2.6 },
    "glm-5.3": { input: 8, output: 28, cacheRead: 2.3 },
    // 官方口径（晚点 2026-08：flash=其 1/10；360 聚合页 7.6/26.6 基本一致）
    "glm-5.3-flash": { input: 0.8, output: 2.8, cacheRead: 0.23 },
    // 官方口径（晚点/chinaz 2026-08）
    "glm-4.7": { input: 2, output: 8, cacheRead: 0.2 },
    // 360 模型广场聚合页（官方价页未列 4.7+ 世代）
    "glm-4.6": { input: 1, output: 4 },
    // ESTIMATE，待智谱价格页核对
    "glm-4.5-air": { input: 0.5, output: 1 }
    // ESTIMATE，待智谱价格页核对
  };
  let ledger = new ModelLedger();
  try {
    if (existsSync(ledgerPath)) ledger = ModelLedger.fromJSON(JSON.parse(readFileSync(ledgerPath, "utf8")));
  } catch {
  }
  const persistLedger = () => {
    try {
      mkdirSync(join(ledgerPath, ".."), { recursive: true });
      writeFileSync(ledgerPath, JSON.stringify(ledger.toJSON()));
    } catch {
    }
  };
  ctx.provide("jisi", createJisiService(ctx, provider, ledger, persistLedger));
  ctx.tools.register(defineTool({
    name: "jisi_fanout",
    description: "Fan a prompt out to multiple models in parallel and return their raw reports, unsynthesized. ANY agent may call this at any time \u2014 especially when stuck on a hard problem and wanting diverse approaches or fresh ideas. The models are released once they answer; you decide when to call, how many models, and how many ideas to ask for (nothing is forced).",
    parameters: {
      prompt: { type: "string", required: true, description: "The self-contained work/idea prompt sent to every model." },
      models: { type: "array", description: "Model ids to fan out to. Default: the registered model list." },
      effort: { type: "string", description: "Reasoning effort (off/low/high/max) where supported; unsupported efforts are dropped per model." }
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }]
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const agent = exec.agent;
      if (agent === void 0) throw new Error("jisi_fanout requires a calling agent");
      const models = args.models ?? (await ctx.jisi.listModels()).map((m) => m.id);
      if (models.length === 0) return "jisi_fanout: no models registered";
      const reports = await ctx.jisi.fanout(agent, { prompt: args.prompt }, models, {
        background: false,
        ...args.effort !== void 0 ? { reasoningEffort: args.effort } : {}
      });
      return reports.map((r, i) => `[${models[i]}] ${r.status}: ${r.text.trim()}`).join("\n\n");
    }
  }));
  ctx.tools.register(defineTool({
    name: "jisi_model_report",
    description: "Report the model capability ledger: per (model, dimension, key) attempts/wins/smoothed rate. Use it to assign the most suitable executor or idea-giver; rates learn over time (Laplace-smoothed, price tiebreak on ties).",
    parameters: {},
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }]
    },
    isConcurrencySafe: () => true,
    async execute() {
      const summary = ctx.jisi.ledger.summary();
      if (summary.length === 0) return "jisi_model_report: ledger is empty (cold start \u2014 all candidates equal, cheapest wins)";
      return summary.map((s) => `${s.dimension}/${s.key} ${s.model}: ${s.wins}/${s.attempts} (rate ${s.rate.toFixed(2)})`).join("\n");
    }
  }));
  ctx.tools.register(defineTool({
    name: "jisi_usage",
    description: "Aggregate per-model token usage and cost (CNY) from the local usage sidecar (llm-openai-compat writes every call). Kimi/DeepSeek prices are calibrated from official pricing pages (2026-09-08); DeepSeek costs respect peak vs off-peak hours (nights/weekends are half price); cache-hit tokens are priced at the cache-hit rate. GLM entries are still estimates. Use it every round to keep spend in check.",
    parameters: {},
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => true,
    async execute() {
      const sidecar = join(process.env.DSH_HOME ?? ".", "storages", "llm-usage.jsonl");
      const totals = /* @__PURE__ */ new Map();
      try {
        if (existsSync(sidecar)) {
          for (const line of readFileSync(sidecar, "utf8").split("\n")) {
            if (line.trim() === "") continue;
            const record = JSON.parse(line);
            const key = `${record.provider ?? "?"}/${record.model ?? "?"}`;
            const t = totals.get(key) ?? { calls: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cost: 0 };
            t.calls += 1;
            const model = record.model ?? "?";
            const ri = record.inputTokens ?? 0;
            const ro = record.outputTokens ?? 0;
            const rr = record.reasoningTokens ?? 0;
            const rc = record.cacheReadTokens ?? 0;
            t.input += ri;
            t.output += ro;
            t.reasoning += rr;
            t.cacheRead += rc;
            const price = priceTable[model];
            if (price !== void 0) {
              const p = isBeijingPeak(record.at) ? price : price.idle ?? price;
              const hit = p.cacheRead ?? p.input;
              t.cost += (ri * p.input + rc * hit + ro * p.output + rr * (p.reasoning ?? p.output)) / 1e6;
            }
            totals.set(key, t);
          }
        }
      } catch {
      }
      if (totals.size === 0) return "jisi_usage: no usage recorded yet (sidecar empty)";
      const rows = [];
      let grand = 0;
      for (const [key, t] of [...totals.entries()].sort((a, b) => b[1].input + b[1].output - a[1].input - a[1].output)) {
        const model = key.split("/")[1] ?? "?";
        grand += t.cost;
        rows.push(`${key}: ${t.calls} calls, in=${t.input} out=${t.output} reasoning=${t.reasoning} cacheRead=${t.cacheRead} \u2192 ~\xA5${t.cost.toFixed(2)}${priceTable[model] === void 0 ? " (no price, uncounted)" : ""}`);
      }
      rows.push(`TOTAL estimated: ~\xA5${grand.toFixed(2)} (Kimi/DeepSeek calibrated 2026-09-08; GLM entries are estimates)`);
      return rows.join("\n");
    }
  }));
  ctx.tools.register(defineTool({
    name: "jisi_record",
    description: "Record one model-ability judgment: execution outcome (dimension=execution, key=difficulty, win=solved) or idea quality (dimension=idea, key=freeform category, win=adopted/verified). The ledger learns from every record.",
    parameters: {
      model: { type: "string", required: true, description: "Model id being rated." },
      dimension: { type: "string", required: true, description: "execution | idea." },
      key: { type: "string", required: true, description: "Dimension key (e.g. difficulty for execution, challenge/category for idea)." },
      win: { type: "boolean", required: true, description: "true = solved/adopted/verified; false = failed/dead-end." }
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }]
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      if (args.dimension !== "execution" && args.dimension !== "idea") return "jisi_record: dimension must be execution | idea";
      ctx.jisi.ledger.record(args.model, args.dimension, args.key, args.win);
      return `recorded: ${args.model} ${args.dimension}/${args.key} ${args.win ? "win" : "loss"}`;
    }
  }));
}
export {
  apply,
  inject,
  isBeijingPeak,
  name
};
