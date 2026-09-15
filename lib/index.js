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

// src/model-ledger-v2.ts
var QUESTION_TYPES = ["web", "crypto", "pwn", "rev", "forensics", "misc"];
function difficultyBucket(d) {
  if (d < 40) return 0;
  if (d < 70) return 1;
  return 2;
}
var DEFAULT_CONFIG = {
  shrinkageStrength: 5,
  modelAliases: {},
  voidModels: []
};
function sampleGamma(shape, rng = Math.random) {
  if (shape < 1) {
    return sampleGamma(shape + 1, rng) * Math.pow(rng(), 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (; ; ) {
    let x = 0;
    let v = 0;
    do {
      x = normalSample(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
function normalSample(rng) {
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
function sampleBeta(a, b, rng = Math.random) {
  const g1 = sampleGamma(a, rng);
  const g2 = sampleGamma(b, rng);
  return g1 / (g1 + g2);
}
var ModelLedgerV2 = class _ModelLedgerV2 {
  records = [];
  config;
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }
  static fromJSON(data, config) {
    const ledger = new _ModelLedgerV2(config);
    const records = data?.records ?? [];
    for (const r of records) if (r !== null && typeof r === "object") ledger.records.push(r);
    return ledger;
  }
  toJSON() {
    return { records: [...this.records] };
  }
  /** 记一条(加权)。 */
  record(r) {
    this.records.push({ ...r, at: r.at ?? Date.now() });
  }
  /** 所有记录(报告/分析用)。 */
  all() {
    return [...this.records];
  }
  /** 规范化模型名(别名继承)。 */
  canon(model) {
    let m = model;
    let guard = 0;
    while (this.config.modelAliases[m] !== void 0 && guard < 8) {
      m = this.config.modelAliases[m];
      guard += 1;
    }
    return m;
  }
  /** 单元格伪计数(仅观测; 先验在聚合时叠加)。 */
  cellCounts(model, dimension, qtype, bucket) {
    let a = 0;
    let b = 0;
    for (const r of this.records) {
      if (r.dimension !== dimension) continue;
      if (this.canon(r.model) !== model) continue;
      if (r.qtype !== qtype) continue;
      if (difficultyBucket(r.difficulty) !== bucket) continue;
      if (r.win) a += r.weight;
      else b += r.weight;
    }
    return { a, b };
  }
  /** 三层收缩后的有效伪计数(先验加在这里: L0 层叠全局先验)。 */
  effectiveCounts(model, dimension, qtype, bucket, priorA = 0, priorB = 0) {
    const m = this.canon(model);
    const cell = this.cellCounts(m, dimension, qtype, bucket);
    const type = this.typeCounts(m, dimension, qtype);
    const glob = this.globalCounts(m, dimension);
    const s = this.config.shrinkageStrength;
    let cellA = cell.a;
    let cellB = cell.b;
    if (cellA + cellB === 0) {
      let parentMean;
      if (type.a + type.b > 0) parentMean = (type.a + 1) / (type.a + type.b + 2);
      else if (glob.a + glob.b > 0) parentMean = (glob.a + 1) / (glob.a + glob.b + 2);
      if (parentMean !== void 0) {
        cellA = parentMean * s;
        cellB = (1 - parentMean) * s;
      }
    }
    return { a: cellA + priorA, b: cellB + priorB, cellA: cell.a, cellB: cell.b, typeA: type.a, typeB: type.b, globalA: glob.a, globalB: glob.b };
  }
  typeCounts(model, dimension, qtype) {
    let a = 0;
    let b = 0;
    for (const r of this.records) {
      if (r.dimension !== dimension || this.canon(r.model) !== model || r.qtype !== qtype) continue;
      if (r.win) a += r.weight;
      else b += r.weight;
    }
    return { a, b };
  }
  globalCounts(model, dimension) {
    let a = 0;
    let b = 0;
    for (const r of this.records) {
      if (r.dimension !== dimension || this.canon(r.model) !== model) continue;
      if (r.win) a += r.weight;
      else b += r.weight;
    }
    return { a, b };
  }
  /** 单元格统计(含收缩+先验)。 */
  cellStats(model, dimension, qtype, bucket, priorA = 0, priorB = 0) {
    const { a, b, cellA, cellB } = this.effectiveCounts(model, dimension, qtype, bucket, priorA, priorB);
    const mean = (a + 1) / (a + b + 2);
    let cost = 0;
    let pts = 0;
    let mins = 0;
    for (const r of this.records) {
      if (r.dimension !== dimension || this.canon(r.model) !== model || r.qtype !== qtype) continue;
      if (difficultyBucket(r.difficulty) !== bucket) continue;
      cost += r.costCny ?? 0;
      mins += r.elapsedMin ?? 0;
      if (r.win) pts += r.difficultyPoints ?? r.difficulty;
    }
    return {
      a,
      b,
      mean,
      n: cellA + cellB,
      cnyPerDifficulty: pts > 0 ? cost / pts : Number.NaN,
      difficultyPerMin: mins > 0 ? pts / mins : Number.NaN
    };
  }
  /**
   * Thompson 排名: 每个候选抽一个后验实现, 降序。
   * 返回该难度桶(按难度插值到桶内)的样本值。
   */
  rank(dimension, qtype, difficulty, candidates, priors = () => ({ a: 0, b: 0 }), rng = Math.random) {
    const bucket = difficultyBucket(difficulty);
    const out = [];
    for (const model of candidates) {
      const m = this.canon(model);
      if (this.config.voidModels.includes(m)) continue;
      const p = priors(m);
      const { a, b, n } = this.cellStats(m, dimension, qtype, bucket, p.a, p.b);
      out.push({
        model: m,
        thompson: sampleBeta(a + 1, b + 1, rng),
        mean: (a + 1) / (a + b + 2),
        n,
        cell: `${dimension}/${qtype}/d${bucket}`
      });
    }
    return out.sort((x, y) => y.thompson - x.thompson);
  }
  /** 四指标之一/二: idea 加权终胜率、execution 加权首胜率(全格汇总, 供 model_report)。 */
  summary(dimension) {
    const out = [];
    const models = /* @__PURE__ */ new Set();
    for (const r of this.records) if (r.dimension === dimension) models.add(this.canon(r.model));
    for (const m of models) {
      if (this.config.voidModels.includes(m)) continue;
      for (const qtype of QUESTION_TYPES) {
        for (const bucket of [0, 1, 2]) {
          const st = this.cellStats(m, dimension, qtype, bucket);
          if (st.n <= 0) continue;
          out.push({ model: m, qtype, bucket, mean: st.mean, n: st.n, cnyPerDifficulty: st.cnyPerDifficulty, difficultyPerMin: st.difficultyPerMin });
        }
      }
    }
    return out.sort((x, y) => y.mean - x.mean);
  }
};

// src/difficulty.ts
function priorFromScore(score) {
  if (score <= 0) return 0;
  return Math.min(100, Math.round(100 * (1 - Math.exp(-score / 600))));
}

// src/benchmark-priors.ts
var BENCHMARK_PRIORS = {
  "deepseek-flash": [
    { name: "CyberGym", score: 88.1, nTasks: 100, dimension: "execution", qtype: "misc", source: "DeepSeek changelog 2026-09-10", date: "2026-09-10" },
    { name: "SEC-Bench Pro", score: 62.8, nTasks: 500, dimension: "idea", qtype: "misc", source: "DeepSeek changelog 2026-09-10", date: "2026-09-10" },
    { name: "ExploitGym", score: 15.3, nTasks: 40, dimension: "execution", qtype: "pwn", source: "DeepSeek changelog 2026-09-10", date: "2026-09-10" }
  ]
};
var PRIOR_DISCOUNT = 0.25;
function priorStrength(score, nTasks, discount = PRIOR_DISCOUNT) {
  const p = Math.min(Math.max(score / 100, 1e-3), 0.999);
  const se2 = p * (1 - p) / Math.max(nTasks, 1);
  return discount / (4 * se2);
}
function priorsFor(model, dimension, qtype, table = BENCHMARK_PRIORS) {
  let a = 0;
  let b = 0;
  const sources = [];
  for (const src of table[model] ?? []) {
    if (src.dimension !== dimension || src.qtype !== qtype) continue;
    const k = priorStrength(src.score, src.nTasks);
    const p = src.score / 100;
    a += p * k;
    b += (1 - p) * k;
    sources.push(`${src.name}(${src.score},n=${src.nTasks},k\u2248${k.toFixed(0)})@${src.date}`);
  }
  return { a, b, sources };
}

// src/score.ts
function winWeight(difficulty, kW = 1) {
  const d = Math.max(difficulty, 0);
  return kW * Math.log(1 + d / 25);
}
function failWeight(difficulty, kF = 1) {
  const d = Math.max(difficulty, 0.1);
  return kF * Math.log(1 + 25 / d);
}

// src/attack-surfaces.ts
var ATTACK_SURFACES = {
  web: [
    { id: "recon", name: "\u4FA6\u5BDF/\u6307\u7EB9", keywords: ["recon", "\u6307\u7EB9", "banner", "\u76EE\u5F55", "dirsearch", "robots"] },
    { id: "authn", name: "\u8BA4\u8BC1", keywords: ["login", "\u8BA4\u8BC1", "password", "\u5BC6\u7801", "jwt", "session", "cookie", "captcha", "otp"] },
    { id: "sqli", name: "SQL \u6CE8\u5165", keywords: ["sqli", "sql injection", "\u6CE8\u5165", "select '", "union"] },
    { id: "xss", name: "XSS", keywords: ["xss", "script", "\u8DE8\u7AD9"] },
    { id: "ssrf", name: "SSRF", keywords: ["ssrf", "url=", "proxy", "fetch url"] },
    { id: "idor", name: "IDOR/\u8D8A\u6743", keywords: ["idor", "\u8D8A\u6743", "id=", "uuid", "\u6C34\u5E73\u6743\u9650"] },
    { id: "lfi", name: "\u6587\u4EF6\u5305\u542B/\u8BFB\u53D6", keywords: ["lfi", "rfi", "file=", "include", "path traversal", "\u76EE\u5F55\u7A7F\u8D8A", "file://"] },
    { id: "upload", name: "\u6587\u4EF6\u4E0A\u4F20", keywords: ["upload", "\u4E0A\u4F20", "multipart"] },
    { id: "rce", name: "\u547D\u4EE4/\u4EE3\u7801\u6267\u884C", keywords: ["rce", "exec", "command", "\u4EE3\u7801\u6267\u884C", "\u53CD\u5E8F\u5217\u5316", "deserial", "pickle", "eval"] },
    { id: "ssrf-intra", name: "\u5185\u7F51\u6A2A\u5411", keywords: ["\u5185\u7F51", "\u6A2A\u5411", "ssrf \u5185\u7F51", "intranet", "redis", "\u4EE3\u7406"] },
    { id: "crypto-weak", name: "\u5F31\u52A0\u5BC6/\u5F31\u5BC6\u94A5", keywords: ["\u5F31\u5BC6\u94A5", "\u786C\u7F16\u7801", "key leak", "weak crypto"] },
    { id: "logic", name: "\u4E1A\u52A1\u903B\u8F91", keywords: ["\u903B\u8F91", "\u8D8A\u6743\u903B\u8F91", "race", "\u6761\u4EF6\u7ADE\u4E89", "\u6298\u6263"] }
  ],
  crypto: [
    { id: "weak-param", name: "\u5F31\u53C2\u6570", keywords: ["n \u5C0F", "e=3", "\u5171\u6A21", "\u5C0F\u516C\u94A5", "factor", "yafu"] },
    { id: "congruence", name: "\u540C\u4F59/CRT", keywords: ["crt", "\u540C\u4F59", "chinese remainder"] },
    { id: "lattice", name: "\u683C\u653B\u51FB", keywords: ["lattice", "\u683C", "lll", "coppersmith", "hidden number"] },
    { id: "algebra", name: "\u4EE3\u6570\u7ED3\u6784", keywords: ["groebner", "\u591A\u9879\u5F0F", "\u6709\u9650\u57DF", "galois"] },
    { id: "padding", name: "Padding \u9884\u8A00\u673A", keywords: ["padding oracle", "bleichenbacher", "pkcs"] },
    { id: "reuse", name: "\u5BC6\u94A5/\u968F\u673A\u6570\u91CD\u7528", keywords: ["nonce reuse", "\u968F\u673A\u6570", "stream", "\u540C\u4E00\u5BC6\u94A5"] },
    { id: "side", name: "\u4FA7\u4FE1\u9053/\u6CC4\u9732", keywords: ["\u6CC4\u9732", "oracle", "crc", "\u566A\u58F0", "\u5019\u9009\u503C", "timing"] },
    { id: "impl", name: "\u5B9E\u73B0\u7F3A\u9677", keywords: ["\u5B9E\u73B0", "\u8F6E\u6570", "\u81EA\u5B9E\u73B0", "\u81EA\u5B9A\u4E49"] }
  ],
  pwn: [
    { id: "overflow", name: "\u6808\u6EA2\u51FA", keywords: ["overflow", "\u6808", "ret2", "rop", "buffer"] },
    { id: "heap", name: "\u5806\u5229\u7528", keywords: ["heap", "\u5806", "tcache", "uaf", "double free"] },
    { id: "fmt", name: "\u683C\u5F0F\u5316\u5B57\u7B26\u4E32", keywords: ["fmt", "format string", "\u683C\u5F0F\u5316"] },
    { id: "logic-bug", name: "\u903B\u8F91\u6F0F\u6D1E", keywords: ["\u903B\u8F91", "integer", "\u8D8A\u754C", "off-by-one"] },
    { id: "env", name: "\u73AF\u5883\u7ED5\u8FC7", keywords: ["canary", "pie", "aslr", "nx", "seccomp", "\u6C99\u7BB1"] }
  ],
  rev: [
    { id: "static", name: "\u9759\u6001\u5206\u6790", keywords: ["ida", "ghidra", "\u53CD\u7F16\u8BD1", "disassemble", "strings"] },
    { id: "dynamic", name: "\u52A8\u6001\u8C03\u8BD5", keywords: ["gdb", "\u8C03\u8BD5", "\u65AD\u70B9", "trace"] },
    { id: "crypto-inner", name: "\u5185\u7F6E\u7B97\u6CD5\u8FD8\u539F", keywords: ["\u7B97\u6CD5", "\u5BC6\u94A5\u8C03\u5EA6", "\u8FD8\u539F", "check", "\u6821\u9A8C"] },
    { id: "vm", name: "VM/\u89E3\u91CA\u5668", keywords: ["vm", "\u89E3\u91CA\u5668", "opcode", "\u865A\u62DF\u673A"] }
  ],
  forensics: [
    { id: "fs", name: "\u6587\u4EF6\u7CFB\u7EDF/\u78C1\u76D8", keywords: ["\u78C1\u76D8", "\u955C\u50CF", "filesystem", "mft"] },
    { id: "net", name: "\u6D41\u91CF\u5206\u6790", keywords: ["pcap", "\u6D41\u91CF", "wireshark", "\u534F\u8BAE"] },
    { id: "mem", name: "\u5185\u5B58\u53D6\u8BC1", keywords: ["\u5185\u5B58", "volatility", "dump"] },
    { id: "artifact", name: "\u5DE5\u4EF6\u89E3\u6790", keywords: ["\u65E5\u5FD7", "\u6D4F\u89C8\u5668", "\u6CE8\u518C\u8868", "artifact", "\u65F6\u95F4\u7EBF"] },
    { id: "stego", name: "\u9690\u5199", keywords: ["stego", "\u9690\u5199", "lsb", "metadata", "exif"] }
  ],
  misc: [
    { id: "generic", name: "\u901A\u7528\u7EBF\u7D22", keywords: ["\u7EBF\u7D22", "\u63D0\u793A", "\u7F16\u7801", "base64", "hex"] },
    { id: "guess", name: "\u5BC6\u7801\u5B66\u6742\u9879", keywords: ["\u5BC6\u7801", "\u52A0\u5BC6", "\u89E3\u5BC6"] }
  ]
};
function coverageOf(qtype, triedTexts) {
  const surfaces = ATTACK_SURFACES[qtype] ?? [];
  const covered = /* @__PURE__ */ new Set();
  for (const text of triedTexts) {
    const low = text.toLowerCase();
    for (const s of surfaces) {
      if (s.keywords.some((k) => low.includes(k))) covered.add(s.id);
    }
  }
  const uncovered = surfaces.filter((s) => !covered.has(s.id)).map((s) => `${s.id}(${s.name})`);
  return {
    qtype,
    total: surfaces.length,
    covered: covered.size,
    uncovered,
    ratio: surfaces.length === 0 ? 1 : covered.size / surfaces.length
  };
}

// src/stopping-rule.ts
var DEFAULT_STOPPING = {
  escalateFailedMin: 2,
  deadFailedMin: 4,
  stallMinutesAsFail: 20,
  coverageSaturated: 0.8,
  minTroopsToDie: 3,
  minModelExhaustion: 1,
  maxR2: 2
};
function decide(input, cfg = DEFAULT_STOPPING) {
  const effectiveFails = input.filteredFailed + Math.floor(input.noProgressMin / cfg.stallMinutesAsFail);
  const reasons = [];
  const escalated = input.r2Count >= cfg.maxR2;
  const coverageSaturated = input.coverageRatio >= cfg.coverageSaturated;
  const exhausted = input.modelExhaustion >= cfg.minModelExhaustion;
  const troopsEnough = input.troops >= cfg.minTroopsToDie;
  const deadConditions = {
    fails: effectiveFails >= cfg.deadFailedMin,
    coverage: coverageSaturated,
    exhausted,
    troops: troopsEnough,
    escalated
  };
  const deadCount = Object.values(deadConditions).filter(Boolean).length;
  if (deadConditions.fails && deadConditions.coverage && deadConditions.exhausted && deadConditions.troops && deadConditions.escalated) {
    reasons.push(`\u4E0D\u53EF\u884C\u6027\u8BC1\u636E\u9F50\u5907: \u8FC7\u6EE4\u5931\u8D25 ${effectiveFails}\u2265${cfg.deadFailedMin}, \u8986\u76D6 ${(input.coverageRatio * 100).toFixed(0)}%\u2265${cfg.coverageSaturated * 100}%, \u6A21\u578B\u5F81\u96C6\u7A77\u5C3D, \u5175\u529B ${input.troops}\u2265${cfg.minTroopsToDie}, R2 \u5DF2\u7A77\u5C3D ${input.r2Count}/${cfg.maxR2}`);
    reasons.push("\u5224\u6B7B\u5EFA\u8BAE: \u5206\u6570\u673A\u4F1A\u6210\u672C = \u5269\u4F59 " + input.remainingPoints + " \u5206; \u82E5\u5224\u6B7B\u8BF7 report(failed, why=approach-dead-end) \u7559\u6863");
    return { action: "judge-dead", reasons };
  }
  if (deadCount >= 3) {
    reasons.push(`\u63A5\u8FD1\u5224\u6B7B(${deadCount}/5 \u6761\u4EF6\u6EE1\u8DB3): ${JSON.stringify(deadConditions)}`);
  }
  if (effectiveFails >= cfg.escalateFailedMin && !escalated) {
    reasons.push(`\u8FC7\u6EE4\u5931\u8D25 ${effectiveFails}\u2265${cfg.escalateFailedMin} \u4E14 R2 \u672A\u7A77\u5C3D(${input.r2Count}/${cfg.maxR2}) \u2192 \u5347\u7EA7: xiaochang_refanout \u4E8C\u6B21\u5F81\u96C6(\u5E26\u5165\u6B7B\u8DEF/\u7F3A\u53E3)`);
    return { action: "escalate", reasons };
  }
  if (input.noProgressMin >= cfg.stallMinutesAsFail && input.r2Count === 0) {
    reasons.push(`\u65E0\u8FDB\u5C55 ${input.noProgressMin}min \u2265 ${cfg.stallMinutesAsFail}min \u2192 \u5EFA\u8BAE\u6362\u601D\u8DEF\u6216\u8865\u4E0A\u4E0B\u6587(\u5148\u4E8E R2 \u7684\u8F7B\u5347\u7EA7)`);
    return { action: "escalate", reasons };
  }
  reasons.push(`\u7EE7\u7EED: \u8FC7\u6EE4\u5931\u8D25 ${effectiveFails}/${cfg.deadFailedMin}, \u8986\u76D6 ${(input.coverageRatio * 100).toFixed(0)}%, \u5175\u529B ${input.troops}, \u96BE\u5EA6 ${input.difficulty}`);
  return { action: "continue", reasons };
}

// src/index.ts
import { readBalanceExhausted } from "@shence/dsh-compat";

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
  const fanoutDefaultModels = config.fanoutDefaultModels ?? ["deepseek-v4-flash", "deepseek-flash", "glm-5.3-flash"];
  const exhaustedProviders = () => new Set(readBalanceExhausted().map((r) => r.provider));
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
  const seedLedgerPath = config.seedLedgerPath ?? join2(process.env.DSH_HOME ?? ".", "storages", "jisi-model-ledger.seed.json");
  let ledger = new ModelLedger();
  let seeded = false;
  try {
    if (existsSync(ledgerPath)) {
      ledger = ModelLedger.fromJSON(JSON.parse(readFileSync(ledgerPath, "utf8")));
    } else if (existsSync(seedLedgerPath)) {
      const raw = JSON.parse(readFileSync(seedLedgerPath, "utf8"));
      const executionOnly = { models: {} };
      for (const [model, m] of Object.entries(raw?.models ?? {})) {
        const exec = m?.dimensions?.execution;
        if (exec === void 0) continue;
        executionOnly.models[model] = { dimensions: { execution: exec } };
      }
      ledger = ModelLedger.fromJSON(executionOnly);
      seeded = true;
    }
  } catch {
  }
  const persistLedger = () => {
    try {
      mkdirSync2(join2(ledgerPath, ".."), { recursive: true });
      writeFileSync(ledgerPath, JSON.stringify(ledger.toJSON()));
    } catch {
    }
  };
  const persistLedgerV2 = () => {
    try {
      mkdirSync2(join2(ledgerV2Path, ".."), { recursive: true });
      writeFileSync(ledgerV2Path, JSON.stringify(ledgerV2.toJSON()));
    } catch {
    }
  };
  const adoptions = /* @__PURE__ */ new Map();
  const adoptionDead = /* @__PURE__ */ new Map();
  const adoptionAdopted = /* @__PURE__ */ new Map();
  const kW = config.kW ?? 1;
  const kF = config.kF ?? 1;
  const sel = config.fanoutSelection ?? {};
  const fanoutSel = {
    strategy: sel.strategy ?? "top-fraction",
    fraction: sel.fraction ?? 0.5,
    n: sel.n ?? 3,
    min: sel.min ?? 1,
    max: sel.max ?? 0
  };
  const selectModels = (ranked) => {
    let picked = ranked;
    if (fanoutSel.strategy === "top-n") picked = ranked.slice(0, fanoutSel.n);
    else if (fanoutSel.strategy === "top-fraction") picked = ranked.slice(0, Math.max(fanoutSel.min, Math.round(ranked.length * fanoutSel.fraction)));
    if (fanoutSel.max > 0) picked = picked.slice(0, fanoutSel.max);
    return picked;
  };
  if (seeded) persistLedger();
  const ledgerV2Path = join2(process.env.DSH_HOME ?? ".", "storages", "jisi-model-ledger-v2.json");
  let ledgerV2 = new ModelLedgerV2({
    shrinkageStrength: config.shrinkageStrength ?? 5,
    modelAliases: config.modelAliases ?? {},
    voidModels: config.voidModels ?? []
  });
  try {
    if (existsSync(ledgerV2Path)) {
      ledgerV2 = ModelLedgerV2.fromJSON(JSON.parse(readFileSync(ledgerV2Path, "utf8")), {
        shrinkageStrength: config.shrinkageStrength ?? 5,
        modelAliases: config.modelAliases ?? {},
        voidModels: config.voidModels ?? []
      });
    } else {
      const migrateSource = existsSync(ledgerPath) ? ledgerPath : existsSync(seedLedgerPath) ? seedLedgerPath : void 0;
      if (migrateSource !== void 0) {
        const legacy = ModelLedger.fromJSON(JSON.parse(readFileSync(migrateSource, "utf8")));
        for (const row of legacy.summary()) {
          if (row.dimension !== "execution") continue;
          const diff = Number(row.key) || priorFromScore(300);
          for (let i = 0; i < row.attempts; i += 1) {
            ledgerV2.record({ model: row.model, dimension: "execution", qtype: "misc", difficulty: diff, weight: 1, win: i < row.wins, source: "observation", note: "migrated-legacy" });
          }
        }
        persistLedgerV2();
      }
    }
  } catch {
  }
  const jisiService = createJisiService(ctx, provider, ledger, persistLedger, disabledModels);
  ctx.provide("jisi", {
    ...jisiService,
    isModelQuarantined: async (model) => {
      try {
        const catalog = await jisiService.listModels();
        const info = catalog.find((m) => m.id === model);
        return info !== void 0 && exhaustedProviders().has(info.provider);
      } catch {
        return false;
      }
    },
    /** v2 加权入账(第 0/1 层)。 */
    recordV2: (r) => {
      ledgerV2.record({ ...r, source: "observation" });
      persistLedgerV2();
    },
    /** 终局对账(采纳的思路): 胜不动; 败且 approach-dead-end → 罚思路模型。 */
    settleAdoptions: (code, win, attribution) => {
      const entries = adoptions.get(code) ?? [];
      if (entries.length === 0) return;
      adoptions.delete(code);
      if (win) return;
      if (attribution !== "approach-dead-end") return;
      adoptionDead.set(code, (adoptionDead.get(code) ?? 0) + entries.length);
      for (const e of entries) {
        ledgerV2.record({
          model: e.model,
          dimension: "idea",
          qtype: "misc",
          difficulty: e.difficulty,
          weight: failWeight(e.difficulty, kF),
          win: false,
          attribution,
          source: "observation",
          note: `adopted report ${e.reportId} terminal loss`
        });
      }
      persistLedgerV2();
    },
    ledgerV2: () => ledgerV2,
    /** v2 契合度排名(第 2 层, 供 runner 的 xiaochang_refanout 选模)。 */
    pickRank: async (qtype, difficulty, dimension) => {
      if (!QUESTION_TYPES.includes(qtype)) return [];
      const catalog = await jisiService.listModels();
      return ledgerV2.rank(dimension, qtype, difficulty, catalog.map((m) => m.id), (m) => {
        const pr = priorsFor(m, dimension, qtype);
        return { a: pr.a, b: pr.b };
      }).map((r) => ({ model: r.model, thompson: r.thompson, mean: r.mean, n: r.n }));
    },
    /** v6 不可行性判定(第 6 层): 停止规则裁决 + 攻击面覆盖, 供 runner 的 status 集成。 */
    judge: (input) => decide(input),
    coverage: (qtype, triedTexts) => {
      const r = coverageOf(QUESTION_TYPES.includes(qtype) ? qtype : "misc", triedTexts);
      return { ratio: r.ratio, covered: r.covered, total: r.total, uncovered: r.uncovered };
    },
    /** v2 升级状态(第 3 层): 该题采纳数/已死数, runner 据此打 ⚠️ 建议。 */
    adoptionStats: (code) => ({
      adopted: adoptionAdopted.get(code) ?? 0,
      dead: adoptionDead.get(code) ?? 0
    }),
    /** 采纳裁决(第 0 层): adopted 即记 idea 正(对数权重)。 */
    adjudicate: (code, difficulty, verdicts) => {
      const list = adoptions.get(code) ?? [];
      let adopted = 0;
      for (const v of verdicts) {
        if (v.verdict !== "adopted") continue;
        const w = winWeight(difficulty, kW);
        list.push({ reportId: v.reportId, model: v.model, difficulty, weight: w });
        ledgerV2.record({
          model: v.model,
          dimension: "idea",
          qtype: "misc",
          difficulty,
          weight: w,
          win: true,
          source: "observation",
          note: `adopted ${v.reportId}`
        });
        adopted += 1;
      }
      if (list.length > 0) adoptions.set(code, list);
      if (adopted > 0) adoptionAdopted.set(code, (adoptionAdopted.get(code) ?? 0) + adopted);
      persistLedgerV2();
      return `adjudicated: ${adopted} adopted (idea +w), ${verdicts.length - adopted} not-adopted/pending (no score). \u7EC8\u5C40\u5BF9\u8D26: \u9898\u80DC\u4E0D\u52A0\u5206; \u9898\u8D25\u4E14\u5F52\u56E0 approach-dead-end \u2192 \u601D\u8DEF\u6A21\u578B \u2212w_f.`;
    }
  });
  attachUsageMeter(ctx);
  ctx.tools.register(defineTool({
    name: "jisi_fanout",
    description: "Fan a prompt out to multiple models in parallel and get their raw reports, unsynthesized. ANY agent may call this at any time \u2014 especially when stuck on a hard problem and wanting diverse approaches or fresh ideas. Default mode=notify returns immediately (each model reports independently as it finishes \u2014 the slowest never blocks you); mode=collect blocks until timeoutMinutes and returns the settled subset. Every report carries an envelope line [fanout:<id>] [model] [question] so results from multiple fanouts never get mixed up. Use jisi_fanout_drop to stop the remaining thinking once the question is answered (saves tokens).",
    parameters: {
      prompt: { type: "string", required: true, description: "The self-contained work/idea prompt sent to every model." },
      models: { type: "array", description: "Model ids to fan out to. Default: v2 pick top-fraction (cheap-tier fallback when qtype/difficulty absent); others only when explicitly listed (F34)." },
      effort: { type: "string", description: "Reasoning effort (off/low/high/max) where supported; unsupported efforts are dropped per model." },
      mode: { type: "string", description: "notify (default: return immediately, reports arrive independently) | collect (block for the settled subset)." },
      timeoutMinutes: { type: "number", description: "collect mode timeout in minutes (default 8)." },
      qtype: { type: "string", description: "v2: question type (web/crypto/pwn/rev/forensics/misc) for fit-based default selection." },
      difficulty: { type: "number", description: "v2: calibrated difficulty 0-100 for fit-based default selection." }
    },
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }]
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const agent = exec.agent;
      if (agent === void 0) throw new Error("jisi_fanout requires a calling agent");
      const catalog = await ctx.jisi.listModels();
      const exhausted = exhaustedProviders();
      const allCatalog = catalog.map((m) => m.id);
      let models;
      if (args.models !== void 0) {
        models = args.models;
      } else if (args.qtype !== void 0 && args.difficulty !== void 0 && QUESTION_TYPES.includes(args.qtype)) {
        const ranked = ledgerV2.rank("idea", args.qtype, args.difficulty, allCatalog, (m) => {
          const pr = priorsFor(m, "idea", args.qtype);
          return { a: pr.a, b: pr.b };
        });
        const picked = selectModels(ranked);
        models = picked.map((r) => r.model);
        if (models.length === 0) models = allCatalog.filter((m) => fanoutDefaultModels.includes(m));
      } else {
        models = allCatalog.filter((m) => fanoutDefaultModels.includes(m));
      }
      const blocked = (args.models ?? []).filter((m) => exhausted.has(catalog.find((c) => c.id === m)?.provider ?? ""));
      if (blocked.length > 0) return `jisi_fanout: \u62D2\u7EDD\u663E\u5F0F\u6D3E\u5355 ${blocked.join(", ")}\u2014\u2014\u8BE5 provider \u4F59\u989D\u5DF2\u67AF\u7AED(\u9694\u79BB\u4E2D)\u3002\u6362\u6A21\u578B; \u5E76\u628A"XX \u4F59\u989D\u4E0D\u8DB3"\u5199\u8FDB\u6700\u7EC8\u6218\u62A5\u63D0\u793A\u7528\u6237\u5145\u503C\u3002`;
      models = models.filter((m) => !exhausted.has(catalog.find((c) => c.id === m)?.provider ?? ""));
      if (models.length === 0) return "jisi_fanout: no models registered (check \u4F59\u989D\u9694\u79BB)";
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
      specs: { type: "array", required: true, description: "Fanout specs: [{prompt (required), models? (default flash family only), effort?}]" }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const agent = exec.agent;
      if (agent === void 0) throw new Error("jisi_fanout_bulk requires a calling agent");
      const specs = args.specs ?? [];
      if (specs.length === 0) return "jisi_fanout_bulk: empty specs";
      const catalog = await ctx.jisi.listModels();
      const allIds = catalog.map((m) => m.id);
      const exhausted = exhaustedProviders();
      const defaultIds = allIds.filter((m) => fanoutDefaultModels.includes(m) && !exhausted.has(catalog.find((c) => c.id === m)?.provider ?? ""));
      let totalDelegates = 0;
      const spawned = [];
      for (const spec of specs) {
        const models = (spec.models && spec.models.length > 0 ? spec.models : defaultIds).filter((m) => !exhausted.has(catalog.find((c) => c.id === m)?.provider ?? ""));
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
      const ex = [...exhaustedProviders()];
      const lines = [];
      const seen = /* @__PURE__ */ new Set();
      for (const dim of ["execution", "idea"]) {
        for (const row of ledgerV2.summary(dim)) {
          if (disabledModels.has(row.model)) continue;
          const key = `${dim}/${row.model}/${row.qtype}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const eff = isNaN(row.cnyPerDifficulty) ? "\u2014" : `\xA5${row.cnyPerDifficulty.toFixed(2)}/\u96BE\u5EA6\u70B9`;
          const rate = isNaN(row.difficultyPerMin) ? "\u2014" : `${row.difficultyPerMin.toFixed(1)}\u96BE\u5EA6\u70B9/min`;
          lines.push(`${dim}/${row.qtype}/d${row.bucket} ${row.model}: mean ${row.mean.toFixed(2)} n=${row.n.toFixed(1)} \u6548\u8D39\u6BD4 ${eff} \u65F6\u6548 ${rate}`);
        }
      }
      const voids = ledgerV2.all().filter(() => false);
      if (ex.length > 0) lines.push(`\u26A0\uFE0F \u4F59\u989D\u67AF\u7AED\u9694\u79BB: ${ex.join(", ")} \u2014\u2014 \u76F8\u5173\u6A21\u578B\u5DF2\u81EA\u52A8\u5254\u9664, \u8BF7\u5199\u8FDB\u6700\u7EC8\u6218\u62A5\u63D0\u793A\u7528\u6237\u5145\u503C`);
      if (lines.length === 0) return "jisi_model_report: ledger is empty (cold start \u2014 all candidates equal, Thompson explores)";
      return lines.join("\n");
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
    name: "jisi_pick",
    description: "V2 model picker (layer 2): rank candidate models for one question by fit = question-type/difficulty posterior (weighted Beta + Thompson) + public-benchmark priors. Returns top candidates per dimension (idea=for fanout, execution=for dispatch) with reasons. The main agent keeps the decision; this is evidence, not authority.",
    parameters: {
      qtype: { type: "string", required: true, description: "question type: web/crypto/pwn/rev/forensics/misc" },
      difficulty: { type: "number", required: true, description: "calibrated difficulty 0-100" },
      dimension: { type: "string", description: "execution | idea (default both)" }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => true,
    async execute(args) {
      if (!QUESTION_TYPES.includes(args.qtype)) return `jisi_pick: unknown qtype ${args.qtype} (${QUESTION_TYPES.join("/")})`;
      const catalog = await ctx.jisi.listModels();
      const allCatalog = catalog.map((m) => m.id);
      const dims = args.dimension === "execution" || args.dimension === "idea" ? [args.dimension] : ["execution", "idea"];
      const out = [];
      for (const dim of dims) {
        const ranked = ledgerV2.rank(dim, args.qtype, args.difficulty, allCatalog, (m) => {
          const pr = priorsFor(m, dim, args.qtype);
          return { a: pr.a, b: pr.b };
        });
        out.push(`[${dim}] ${args.qtype}\xB7\u96BE\u5EA6${args.difficulty}:`);
        let i = 0;
        for (const r of ranked) {
          i += 1;
          const pr = priorsFor(r.model, dim, args.qtype);
          const basis = pr.sources.length > 0 ? `\u5148\u9A8C: ${pr.sources.join("; ")}` : "\u5148\u9A8C: \u5747\u5300(Beta(1,1), Thompson \u63A2\u7D22)";
          out.push(`  ${i}. ${r.model} fit=${r.thompson.toFixed(2)} (\u540E\u9A8C\u5747\u503C ${r.mean.toFixed(2)}, n=${r.n.toFixed(1)}) \u2014 ${basis}`);
          if (i >= 5) break;
        }
      }
      return out.join("\n");
    }
  }));
  ctx.tools.register(defineTool({
    name: "jisi_adjudicate",
    description: "V2 idea adjudication (layer 0): verdict each fanout report for one challenge in ONE call: adopted (+w idea, log-weighted by difficulty; terminal win adds nothing, terminal loss with approach-dead-end penalizes -w_f) / not-adopted (0, optional note) / pending (0, never auto-degraded). Report ids come from the [fanout:<id>] envelopes.",
    parameters: {
      code: { type: "string", required: true },
      difficulty: { type: "number", required: true, description: "calibrated difficulty 0-100 (from jisi_pick/profile)" },
      verdicts: { type: "array", required: true, description: "[{reportId, model, verdict: adopted|not-adopted|pending, note?}]" }
    },
    output: { schema: { type: "string" }, render: (_a, v) => [{ type: "text", text: v }] },
    isConcurrencySafe: () => false,
    async execute(args) {
      if (args.verdicts.length === 0) return "jisi_adjudicate: empty verdicts";
      return ctx.jisi.adjudicate(args.code, args.difficulty, args.verdicts);
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
