// src/index.ts
import { existsSync, mkdirSync as mkdirSync2, readFileSync, writeFileSync } from "node:fs";
import { join as join2 } from "node:path";
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
function createJisiService(ctx, provider, modelLedger, onLedgerChange, disabledModels = /* @__PURE__ */ new Set()) {
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
        if (opts.model !== void 0 && disabledModels.has(opts.model)) {
          return { status: "failed", text: `[model-disabled] \u6A21\u578B ${opts.model} \u5DF2\u88AB\u4E34\u65F6\u505C\u7528\uFF08jisi disabledModels \u914D\u7F6E\uFF09\uFF1B\u6362\u7528\u5176\u4ED6\u6A21\u578B\u6216\u5148\u8054\u7CFB\u7BA1\u7406\u5458\u6062\u590D` };
        }
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
              signal: opts.signal ?? new AbortController().signal
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
          signal: opts.signal ?? new AbortController().signal,
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
        if (disabledModels.has(info.id)) continue;
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
  let fanoutSeq = 0;
  const fanouts = /* @__PURE__ */ new Map();
  function envelope(prompt, id, model) {
    const summary = prompt.replace(/\s+/g, " ").trim().slice(0, 40);
    return [
      `[fanout:${id}] [model:${model}] [question:${summary}]`,
      "",
      prompt,
      "",
      "\u4F60\u7684\u6700\u7EC8\u7B54\u590D\u5FC5\u987B\u4EE5\u8FD9\u884C\u4FE1\u5C01\u5F00\u5934\uFF08\u539F\u6837\uFF09\uFF0C\u7136\u540E\u624D\u662F\u4F60\u7684\u5B8C\u6574\u56DE\u7B54\uFF1A",
      `[fanout:${id}] [model:${model}] [question:${summary}]`
    ].join("\n");
  }
  const fanoutNotify = (parent, work, fanModels, opts) => {
    fanoutSeq += 1;
    const id = `fanout-${fanoutSeq}`;
    const controller = new AbortController();
    fanouts.set(id, { controller, models: [...fanModels], dropped: false });
    withParent(parent, () => {
      for (const model of fanModels) {
        channel.delegate(
          { ...work, prompt: envelope(work.prompt, id, model) },
          { ...opts, model, background: true, signal: controller.signal }
        );
      }
    });
    return { id, models: [...fanModels] };
  };
  const fanoutDrop = (id) => {
    const entry = fanouts.get(id);
    if (entry === void 0 || entry.dropped) return false;
    entry.dropped = true;
    entry.controller.abort();
    return true;
  };
  const fanout = async (parent, work, fanModels, opts) => {
    const timeoutMs = opts.timeoutMs ?? 8 * 6e4;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await withParent(parent, async () => {
        const entries = fanModels.map((model) => {
          const result = channel.delegate(
            { ...work, prompt: envelope(work.prompt, "collect", model) },
            { ...opts, model, background: false, signal: controller.signal }
          );
          return { model, report: result.report };
        });
        return await Promise.all(entries.map(async ({ model, report }) => {
          const settled = await Promise.race([
            report,
            new Promise((resolve) => setTimeout(() => resolve({ status: "failed", text: "[timeout]" }), timeoutMs + 5e3))
          ]);
          return { ...settled, model };
        }));
      });
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    delegate(parent, work, opts = {}) {
      return withParent(parent, () => channel.delegate(work, opts));
    },
    fanout,
    fanoutNotify,
    fanoutDrop,
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

// src/usage-meter.ts
import { SessionSeq } from "@deepseek-ai/dsh-session";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
function headerOf(event) {
  if (event.type !== "request/header") return void 0;
  const data = event.data;
  const config = data.header?.config;
  if (config === void 0) return void 0;
  const provider = typeof config.provider === "string" ? config.provider : void 0;
  const model = typeof config.model === "string" ? config.model : void 0;
  if (provider === void 0 && model === void 0) return void 0;
  return { provider, model };
}
function usageOf(event) {
  if (event.type !== "assistant/message") return void 0;
  const data = event.data;
  return data.usage;
}
function attachUsageMeter(ctx) {
  const sidecar = () => join(process.env.DSH_HOME ?? ".", "storages", "llm-usage.jsonl");
  const states = /* @__PURE__ */ new WeakMap();
  const emit = (sid, seq, header, usage) => {
    if (header.provider === void 0 && header.model === void 0) return;
    try {
      const dir = join(sidecar(), "..");
      mkdirSync(dir, { recursive: true });
      appendFileSync(sidecar(), `${JSON.stringify({
        at: Date.now(),
        sid,
        seq,
        provider: header.provider,
        model: header.model,
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        reasoningTokens: usage.reasoningTokens ?? 0,
        cacheReadTokens: usage.cacheReadTokens ?? 0
      })}
`);
    } catch {
    }
  };
  ctx.on("session/event", (session) => {
    let state = states.get(session);
    if (state === void 0) {
      state = { cursor: 0 };
      states.set(session, state);
    }
    const length = session.seq;
    for (let index = state.cursor; index < length; index++) {
      const event = session.eventAt(SessionSeq(index));
      if (event === void 0) break;
      state.cursor = index + 1;
      const header = headerOf(event);
      if (header !== void 0) {
        state.header = header;
        continue;
      }
      const usage = usageOf(event);
      if (usage !== void 0 && state.header !== void 0) {
        emit(session.id, Number(event.seq), state.header, usage);
      }
    }
  });
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
  const ledgerPath = config.ledgerPath ?? join2(process.env.DSH_HOME ?? ".", "storages", "jisi-model-ledger.json");
  const disabledModels = new Set(config.disabledModels ?? []);
  const priceOrder = config.priceOrder ?? ["glm-5.3-flash", "glm-4.5-air", "glm-4.6", "glm-4.7", "deepseek-v4-flash", "deepseek-flash", "kimi-k2.6", "kimi-k2.7-code", "glm-5.3", "kimi-k2.7-code-highspeed", "kimi-k3"];
  const priceTable = config.priceTable ?? {
    // 单价（CNY / 1M token）。2026-09-11 按官方定价页再校准：
    //  - Kimi：platform.kimi.com/docs/pricing/{chat-k3,chat-k27-code,chat-k26}
    //  - DeepSeek：api-docs.deepseek.com/zh-cn/quick_start/pricing/（峰/谷双价，谷=半价；高峰=周一至五 9-12/14-18）
    //  - GLM：官方价页 docs.bigmodel.cn/cn/guide/start/pricing（2026-09-12 会话登录抓取校准）。
    //    实测对账（run 11）：账本 GLM 侧 ≈2.4× 高估实扣（同 Kimi ≈2.5×），疑 reasoning 计入口径，
    //    暂不改公式，待用量明细核对（junji L4-RUN17497-live）。
    // 2026-09-11 DeepSeek 调价：flash 系列统一由 DeepSeek-V4.1-Flash 服务，新价 入1-2/出4-8/缓0.02-0.04（谷/峰）；
    // 旧名 deepseek-v4-flash / deepseek-v4-flash-vision-exp 仍可调用但已下线（按 Flash 价结算）；
    // 新官方名 deepseek-flash。v4-pro 09-14 退役计划已撤销（官方 09-12），继续原价服务。
    "deepseek-v4-flash": { input: 2, output: 8, cacheRead: 0.04, idle: { input: 1, output: 4, cacheRead: 0.02 } },
    "deepseek-flash": { input: 2, output: 8, cacheRead: 0.04, idle: { input: 1, output: 4, cacheRead: 0.02 } },
    // 2026-09-12 官方更新：撤销 09-14 退役计划——V4 Pro 继续原价服务（入4.5-9/出13.5-27）。
    // pro 仍 disabledModels 停用（我方决策：flash 单模满分已验证，花费纪律）；解禁与否由用户裁定。
    // pro 已 disabledModels 停用；重启用前必须按新结算价改本行（09-14 后 = flash 价）。
    "deepseek-v4-pro": { input: 9, output: 27, cacheRead: 0.3, idle: { input: 4.5, output: 13.5, cacheRead: 0.15 } },
    // vision-exp 已下线（09-11 /models 不再列出），请求由 V4.1-Flash 服务按 Flash 价；保留条目仅供历史账计价。
    "deepseek-v4-flash-vision-exp": { input: 2, output: 8, cacheRead: 0.04, idle: { input: 1, output: 4, cacheRead: 0.02 } },
    "kimi-k3": { input: 20, output: 100, cacheRead: 2 },
    "kimi-k2.6": { input: 6.5, output: 27, cacheRead: 1.1 },
    "kimi-k2.7-code": { input: 6.5, output: 27, cacheRead: 1.3 },
    "kimi-k2.7-code-highspeed": { input: 13, output: 54, cacheRead: 2.6 },
    "glm-5.3": { input: 8, output: 28, cacheRead: 2 },
    // 官方 2026-09-12：8/28/缓存命中2（原 2.3 误记，更）
    "glm-5.3-flash": { input: 0.8, output: 2.8, cacheRead: 0.23 },
    // 官方 2026-09-12：0.8/2.8/0.23 ✓（ESTIMATE 升格）
    "glm-4.7": { input: 4, output: 16, cacheRead: 0.8 },
    // 官方阶梯（取最高档保守）：2/8/0.4(出<0.2K)、3/14/0.6(出≥0.2K)、4/16/0.8(入≥32K)
    "glm-4.6": { input: 1, output: 4 },
    // 文本版已从官方价页移除（仅 4.6V/私有部署在售）；ESTIMATE 保留待实扣校准
    "glm-4.5-air": { input: 1.2, output: 8, cacheRead: 0.24 }
    // 官方阶梯（取最高档保守）：0.8/2/0.16、0.8/6/0.16、1.2/8/0.24(入≥32K)
  };
  let ledger = new ModelLedger();
  try {
    if (existsSync(ledgerPath)) ledger = ModelLedger.fromJSON(JSON.parse(readFileSync(ledgerPath, "utf8")));
  } catch {
  }
  const persistLedger = () => {
    try {
      mkdirSync2(join2(ledgerPath, ".."), { recursive: true });
      writeFileSync(ledgerPath, JSON.stringify(ledger.toJSON()));
    } catch {
    }
  };
  ctx.provide("jisi", createJisiService(ctx, provider, ledger, persistLedger, disabledModels));
  attachUsageMeter(ctx);
  ctx.tools.register(defineTool({
    name: "jisi_fanout",
    description: "Fan a prompt out to multiple models in parallel and get their raw reports, unsynthesized. ANY agent may call this at any time \u2014 especially when stuck on a hard problem and wanting diverse approaches or fresh ideas. Default mode=notify returns immediately (each model reports independently as it finishes \u2014 the slowest never blocks you); mode=collect blocks until timeoutMinutes and returns the settled subset. Every report carries an envelope line [fanout:<id>] [model] [question] so results from multiple fanouts never get mixed up. Use jisi_fanout_drop to stop the remaining thinking once the question is answered (saves tokens).",
    parameters: {
      prompt: { type: "string", required: true, description: "The self-contained work/idea prompt sent to every model." },
      models: { type: "array", description: "Model ids to fan out to. Default: the registered model list." },
      effort: { type: "string", description: "Reasoning effort (off/low/high/max) where supported; unsupported efforts are dropped per model." },
      mode: { type: "string", description: "notify (default: return immediately, reports arrive independently) | collect (block for the settled subset)." },
      timeoutMinutes: { type: "number", description: "collect mode timeout in minutes (default 8)." }
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
      const opts = {
        ...args.effort !== void 0 ? { reasoningEffort: args.effort } : {},
        ...args.timeoutMinutes !== void 0 ? { timeoutMs: args.timeoutMinutes * 6e4 } : {}
      };
      if (args.mode === "collect") {
        const reports = await ctx.jisi.fanout(agent, { prompt: args.prompt }, models, opts);
        return reports.map((r) => `[${r.model}] ${r.status}: ${r.text.trim()}`).join("\n\n");
      }
      const ticket = ctx.jisi.fanoutNotify(agent, { prompt: args.prompt }, models, opts);
      return `[fanout:${ticket.id}] dispatched to ${ticket.models.length} model(s) in notify mode: ${ticket.models.join(", ")}.
Each model reports independently as it settles (fastest first) with the envelope [fanout:${ticket.id}] [model] [question]; wait for the reports instead of re-asking. Once the question is answered, call jisi_fanout_drop with id ${ticket.id} to stop the remaining thinking and save tokens.`;
    }
  }));
  ctx.tools.register(defineTool({
    name: "jisi_fanout_bulk",
    description: "Bulk fanout (F31): one tool call spawns idea-collection delegates for MANY prompts \xD7 models at once. This is THE way to run the opening idea sweep in hosted mode \u2014 each main-agent round-trip costs ~20s through the platform gateway, so issue the whole sweep in one call instead of one fanout per round. Returns immediately (notify semantics): every report arrives independently with its [fanout:<id>] [model] [question] envelope.",
    parameters: {
      specs: { type: "array", required: true, description: "Fanout specs: [{prompt (required), models? (default all), effort?}]" }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const agent = exec.agent;
      if (agent === void 0) throw new Error("jisi_fanout_bulk requires a calling agent");
      const specs = args.specs ?? [];
      if (specs.length === 0) return "jisi_fanout_bulk: empty specs";
      const allIds = (await ctx.jisi.listModels()).map((m) => m.id);
      let totalDelegates = 0;
      const spawned = [];
      for (const spec of specs) {
        const models = spec.models && spec.models.length > 0 ? spec.models : allIds;
        if (totalDelegates + models.length > 400) break;
        const opts = { ...spec.effort !== void 0 ? { reasoningEffort: spec.effort } : {} };
        const ticket = ctx.jisi.fanoutNotify(agent, { prompt: spec.prompt }, models, opts);
        totalDelegates += ticket.models.length;
        spawned.push(ticket.id);
      }
      return `jisi_fanout_bulk: ${spawned.length} fanouts spawned (${totalDelegates} model delegates total), ids: ${spawned.join(", ")}.
Reports arrive independently with [fanout:<id>] [model] [question] envelopes; wait for them (xiaochang_wait wakes on their arrival) and call jisi_fanout_drop <id> once a question is answered.`;
    }
  }));
  ctx.tools.register(defineTool({
    name: "jisi_fanout_drop",
    description: "Stop a fanout that is no longer needed: aborts all not-yet-settled model runs (stops their token spend) and marks the ticket dropped \u2014 late reports, if any, should be ignored by their [fanout:<id>] envelope. Call this as soon as the question the fanout was asking is answered.",
    parameters: {
      id: { type: "string", required: true, description: "The fanout id from jisi_fanout (notify mode) return." }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => true,
    async execute(args) {
      const dropped = ctx.jisi.fanoutDrop(args.id);
      return dropped ? `fanout ${args.id} dropped: unsettled runs aborted; ignore any late reports carrying this id.` : `fanout ${args.id}: unknown id or already dropped`;
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
      const summary = ctx.jisi.ledger.summary().filter((s) => !disabledModels.has(s.model));
      if (summary.length === 0) return "jisi_model_report: ledger is empty (cold start \u2014 all candidates equal, cheapest wins)";
      return summary.map((s) => `${s.dimension}/${s.key} ${s.model}: ${s.wins}/${s.attempts} (rate ${s.rate.toFixed(2)})`).join("\n");
    }
  }));
  ctx.tools.register(defineTool({
    name: "jisi_usage",
    description: "Aggregate per-model token usage and cost (CNY) from the local usage sidecar (the usage meter records every LLM call of every provider and every agent \u2014 main and subagents alike). Kimi/DeepSeek prices are calibrated from official pricing pages (2026-09-08); DeepSeek costs respect peak vs off-peak hours (nights/weekends are half price); cache-hit tokens are priced at the cache-hit rate. GLM entries are still estimates. Use it every round to keep spend in check.",
    parameters: {},
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => true,
    async execute() {
      const sidecar = join2(process.env.DSH_HOME ?? ".", "storages", "llm-usage.jsonl");
      const totals = /* @__PURE__ */ new Map();
      const seen = /* @__PURE__ */ new Set();
      try {
        if (existsSync(sidecar)) {
          for (const line of readFileSync(sidecar, "utf8").split("\n")) {
            if (line.trim() === "") continue;
            const record = JSON.parse(line);
            if (record.sid !== void 0 && record.seq !== void 0) {
              const dedupeKey = `${record.sid}#${record.seq}`;
              if (seen.has(dedupeKey)) continue;
              seen.add(dedupeKey);
            }
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
              t.cost += (ri * p.input + rc * hit + ro * p.output) / 1e6;
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
