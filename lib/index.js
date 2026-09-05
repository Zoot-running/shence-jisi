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
  async fanout(work, models) {
    assertValidWork(work);
    const dispatches = models.map((model) => this.delegate(work, { model }));
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
function reportStatus(kind) {
  return kind === "completed" || kind === "blocked" ? kind === "completed" ? "completed" : "blocked" : "failed";
}
function createJisiService(ctx, provider) {
  let currentParent;
  const spawner = {
    spawn(work, opts) {
      const parent = currentParent;
      if (parent === void 0) {
        throw new Error("jisi: delegate requires a parent Agent (pass it explicitly to the service)");
      }
      const agentOptions = {
        ...opts.model !== void 0 ? { model: opts.model } : {},
        ...opts.provider !== void 0 ? { provider: opts.provider } : {}
      };
      const report = (async () => {
        const run = await ctx.subagents.start(provider, {
          label: "jisi-delegate",
          prompt: [{ type: "text", text: work.prompt }],
          parent,
          signal: new AbortController().signal,
          ...Object.keys(agentOptions).length > 0 ? { agentOptions } : {}
        });
        const result = await run.result;
        void settleRun(run);
        return {
          status: reportStatus(result.stopReason),
          text: textOfBlocks(result.output)
        };
      })();
      return { ref: { id: "one-shot" }, report };
    }
  };
  const collector = {
    collect() {
      return Promise.resolve({ status: "failed", text: "jisi: collect is embedded in the dispatch promise for one-shot runs" });
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
    fanout(parent, work, models2) {
      return withParent(parent, () => channel.fanout(work, models2));
    },
    listModels: () => channel.listModels()
  };
}

// src/index.ts
var name = "shence-jisi";
var inject = ["subagents", "llm"];
function apply(ctx, config = {}) {
  const provider = config.provider ?? "spawn";
  ctx.provide("jisi", createJisiService(ctx, provider));
}
export {
  apply,
  inject,
  name
};
