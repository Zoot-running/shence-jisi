// src/index.ts
import z from "@deepseek-ai/schemastery";

// src/adapter.ts
import { attributionHeaders, assertUsableApiKey, LlmError as LlmError3, LlmAdapter, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { appendFileSync, mkdirSync } from "node:fs";

// src/serialize.ts
function textOf(content) {
  let out = "";
  for (const block of content) {
    if (block.type === "text") out += block.text;
  }
  return out;
}
function serializeMessage(message) {
  const out = [];
  switch (message.role) {
    case "system": {
      out.push({ role: "system", content: textOf(message.content) });
      return out;
    }
    case "user": {
      const texts = message.content.filter((b) => b.type === "text");
      if (texts.length === 1) {
        out.push({ role: "user", content: texts[0].text });
      } else {
        out.push({ role: "user", content: texts.map((t) => ({ type: "text", text: t.text })) });
      }
      return out;
    }
    case "assistant": {
      const toolCalls = message.content.filter((b) => b.type === "tool-call").map((b) => ({
        id: b.id,
        type: "function",
        function: { name: b.name, arguments: b.arguments }
      }));
      const reasoning = message.content.find((b) => b.type === "reasoning");
      out.push({
        role: "assistant",
        content: textOf(message.content) || (toolCalls.length > 0 ? "" : null),
        ...reasoning && reasoning.type === "reasoning" ? { reasoning_content: reasoning.text } : {},
        ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {}
      });
      return out;
    }
    default:
      return out;
  }
}
function serializeMessages(messages) {
  const out = [];
  for (const message of messages) {
    const result = message.content.find((b) => b.type === "tool-result");
    if (message.role === "user" && result && result.type === "tool-result") {
      out.push({
        role: "tool",
        tool_call_id: result.toolCallId,
        content: result.content.filter((b) => b.type === "text").map((b) => b.type === "text" ? b.text : "").join("")
      });
      continue;
    }
    out.push(...serializeMessage(message));
  }
  return out;
}
function buildRequest(options, thinking) {
  const request = {
    model: options.model,
    messages: serializeMessages(options.messages),
    stream: true,
    stream_options: { include_usage: true }
  };
  if (options.system !== void 0 && options.system.length > 0) {
    request.messages = [{ role: "system", content: options.system }, ...request.messages];
  }
  if (options.tools !== void 0 && options.tools.length > 0) {
    request.tools = options.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters }
    }));
  }
  if (options.temperature !== void 0) request.temperature = options.temperature;
  if (options.maxTokens !== void 0) request.max_tokens = options.maxTokens;
  if (options.stop !== void 0 && options.stop.length > 0) request.stop = options.stop;
  if (thinking !== void 0 && options.reasoningEffort !== void 0) {
    const effort = String(options.reasoningEffort);
    const value = thinking.efforts[effort] ?? thinking.efforts[thinking.defaultEffort ?? ""];
    if (value !== void 0) request[thinking.param] = value;
  }
  return request;
}

// src/sse.ts
import { EventSourceParserStream } from "eventsource-parser/stream";
import { LlmError } from "@deepseek-ai/dsh-llm";
var DONE = "[DONE]";
async function* parseSse(stream, onComment) {
  const events = stream.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream({ onComment }));
  for await (const { data } of events) {
    yield data;
    if (data === DONE) return;
  }
  throw new LlmError("SSE stream ended without [DONE]", "STREAM_CLOSED");
}

// src/translate.ts
import { brandString } from "@deepseek-ai/dsh-brand";
import { EMPTY_RESPONSE_CODE, LlmError as LlmError2 } from "@deepseek-ai/dsh-llm";
function mapFinishReason(reason) {
  switch (reason) {
    case "stop":
      return { kind: "stop" };
    case "tool_calls":
      return { kind: "tool-calls" };
    case "length":
      return { kind: "max-tokens" };
    default:
      return {
        kind: "error",
        failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() }
      };
  }
}
function mapUsage(usage) {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  const combined = usage.prompt_tokens + usage.completion_tokens;
  const hasExactTotal = Number.isSafeInteger(usage.prompt_tokens) && usage.prompt_tokens >= 0 && Number.isSafeInteger(usage.completion_tokens) && usage.completion_tokens >= 0 && Number.isSafeInteger(combined) && (usage.total_tokens === void 0 || usage.total_tokens === combined);
  return {
    inputTokens: usage.prompt_tokens - (cacheRead ?? 0),
    outputTokens: usage.completion_tokens,
    ...hasExactTotal ? { totalTokens: combined } : {},
    ...cacheRead !== void 0 ? { cacheReadTokens: cacheRead } : {},
    ...reasoning !== void 0 ? { reasoningTokens: reasoning } : {}
  };
}
function acceptIdentity(current, incoming) {
  return typeof incoming === "string" && incoming.length > 0 ? incoming : current;
}
function closeBlock(block) {
  switch (block.kind) {
    case "text":
      return { type: "text", text: block.text };
    case "reasoning":
      return { type: "reasoning", text: block.text };
    case "tool-call":
      return {
        type: "tool-call",
        id: brandString(block.callId ?? ""),
        name: block.name ?? "",
        arguments: block.text
      };
  }
}
async function* translate(payloads) {
  let nextIndex = 0;
  let textBlock;
  let reasoningBlock;
  const toolBlocks = /* @__PURE__ */ new Map();
  const order = [];
  let pendingFinish;
  let pendingUsage;
  function open(kind) {
    const block = { index: nextIndex++, kind, text: "" };
    order.push(block);
    return block;
  }
  for await (const payload of payloads) {
    if (payload === DONE) {
      for (const block of order) {
        yield { type: "block-end", index: block.index, block: closeBlock(block) };
      }
      if (pendingUsage) yield { type: "usage", usage: pendingUsage };
      const reason = pendingFinish ?? { kind: "stop" };
      yield {
        type: "finish",
        reason: reason.kind === "stop" && order.length === 0 ? {
          kind: "error",
          failure: { message: "model returned a completed response with no content", code: EMPTY_RESPONSE_CODE }
        } : reason
      };
      return;
    }
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      throw new LlmError2(`malformed SSE payload: ${payload.slice(0, 120)}`, "MALFORMED_RESPONSE");
    }
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta;
      const reasoning = delta?.reasoning_content;
      if (typeof reasoning === "string" && reasoning.length > 0) {
        if (!reasoningBlock) {
          reasoningBlock = open("reasoning");
          yield { type: "block-start", index: reasoningBlock.index, blockType: "reasoning" };
        }
        reasoningBlock.text += reasoning;
        yield { type: "reasoning-delta", index: reasoningBlock.index, text: reasoning };
      }
      const content = delta?.content;
      if (typeof content === "string" && content.length > 0) {
        if (!textBlock) {
          textBlock = open("text");
          yield { type: "block-start", index: textBlock.index, blockType: "text" };
        }
        textBlock.text += content;
        yield { type: "text-delta", index: textBlock.index, text: content };
      }
      for (const call of delta?.tool_calls ?? []) {
        let block = toolBlocks.get(call.index);
        if (!block) {
          block = open("tool-call");
          toolBlocks.set(call.index, block);
          yield { type: "block-start", index: block.index, blockType: "tool-call" };
        }
        block.callId = acceptIdentity(block.callId, call.id);
        block.name = acceptIdentity(block.name, call.function?.name);
        const fragment = call.function?.arguments ?? "";
        block.text += fragment;
        yield {
          type: "tool-call-delta",
          index: block.index,
          id: brandString(block.callId ?? ""),
          ...block.name !== void 0 ? { name: block.name } : {},
          argumentsDelta: fragment
        };
      }
      if (typeof choice.finish_reason === "string") {
        pendingFinish = mapFinishReason(choice.finish_reason);
      }
    }
    if (chunk.usage) pendingUsage = mapUsage(chunk.usage);
  }
  throw new LlmError2("SSE payload stream ended without [DONE]", "STREAM_CLOSED");
}

// src/adapter.ts
function resolveConnection(facts) {
  const raw = process.env[facts.apiKeyEnv];
  if (raw === void 0 || raw.length === 0) {
    throw new LlmError3(`missing API key for env "${facts.apiKeyEnv}"`, "MISSING_CREDENTIAL");
  }
  return {
    baseURL: facts.baseURL.replace(/\/+$/, ""),
    apiKey: assertUsableApiKey(raw, "@shence/llm-openai-compat", facts.apiKeyEnv)
  };
}
var OpenAICompatAdapter = class extends LlmAdapter {
  constructor(routes) {
    super();
    this.routes = routes;
  }
  providerInfo(provider) {
    return { id: provider, name: provider };
  }
  async listModels(provider) {
    const models = this.routes.get(provider)?.models ?? [];
    return models.map(({ thinking: _thinking, ...model }) => model);
  }
  async resolveModel(provider, model) {
    const compat = this.routes.get(provider)?.models.find((m) => m.id === model);
    const effortIds = Object.keys(compat?.thinking?.efforts ?? {});
    const reasoning = compat?.thinking !== void 0 && effortIds.length > 0 ? {
      efforts: effortIds.map((id) => ({
        id: ReasoningEffortId(id),
        name: compat.thinking.names?.[id] ?? id
      })),
      ...compat.thinking.defaultEffort !== void 0 ? { defaultEffort: ReasoningEffortId(compat.thinking.defaultEffort) } : {}
    } : void 0;
    return {
      provider,
      id: model,
      name: compat?.name ?? model,
      ...reasoning !== void 0 ? { reasoning } : {}
    };
  }
  async *stream(options) {
    const facts = this.routes.get(options.provider);
    if (facts === void 0) {
      throw new LlmError3(`unregistered provider route "${options.provider}"`, "UNKNOWN_PROVIDER");
    }
    const connection = resolveConnection(facts);
    const thinking = facts.models.find((m) => m.id === options.model)?.thinking;
    const request = buildRequest(options, thinking);
    let response;
    try {
      response = await fetch(`${connection.baseURL}/chat/completions`, {
        method: "POST",
        headers: {
          ...attributionHeaders(),
          "content-type": "application/json",
          authorization: `Bearer ${connection.apiKey}`
        },
        body: JSON.stringify(request),
        signal: options.signal
      });
    } catch (error) {
      if (options.signal?.aborted) {
        yield { type: "finish", reason: { kind: "aborted" } };
        return;
      }
      throw new LlmError3(`request to ${connection.baseURL} failed: ${String(error)}`, "TRANSPORT", { cause: error });
    }
    if (!response.ok) {
      let detail = "";
      try {
        const body = await response.json();
        detail = body.error?.message ?? "";
      } catch {
      }
      yield {
        type: "finish",
        reason: { kind: "error", error: { message: detail || `provider ${response.status}`, code: "PROVIDER_ERROR", status: response.status } }
      };
      return;
    }
    if (response.body === null) {
      yield { type: "finish", reason: { kind: "error", error: { message: "empty response body", code: "EMPTY_RESPONSE" } } };
      return;
    }
    let usage;
    for await (const chunk of translate(parseSse(response.body))) {
      if (chunk.type === "usage") usage = chunk.usage;
      yield chunk;
    }
    if (usage !== void 0) {
      try {
        const home = process.env.DSH_HOME ?? ".";
        const dir = `${home}/storages`;
        mkdirSync(dir, { recursive: true });
        appendFileSync(`${dir}/llm-usage.jsonl`, `${JSON.stringify({
          at: Date.now(),
          provider: options.provider,
          model: options.model,
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          reasoningTokens: usage.reasoningTokens ?? 0,
          cacheReadTokens: usage.cacheReadTokens ?? 0
        })}
`);
      } catch {
      }
    }
  }
};

// src/index.ts
var name = "llm-openai-compat";
var inject = ["llm"];
var Config = z.object({
  routes: z.array(
    z.object({
      provider: z.string().required(),
      baseURL: z.string().required(),
      apiKeyEnv: z.string().required(),
      models: z.array(
        z.object({
          id: z.string().required(),
          name: z.string().required(),
          description: z.string(),
          thinking: z.object({
            param: z.string(),
            efforts: z.dict(z.any()),
            defaultEffort: z.string(),
            names: z.dict(z.string())
          })
        })
      )
    })
  ).min(1)
});
function apply(ctx, config) {
  const routes = /* @__PURE__ */ new Map();
  for (const route of config.routes) {
    const models = (route.models ?? []).map((m) => {
      const thinking = m.thinking !== void 0 && m.thinking.param !== "" ? m.thinking : void 0;
      return {
        provider: route.provider,
        id: m.id,
        name: m.name,
        ...m.description !== void 0 ? { description: m.description } : {},
        ...thinking !== void 0 ? { thinking } : {}
      };
    });
    routes.set(route.provider, {
      baseURL: route.baseURL,
      apiKeyEnv: route.apiKeyEnv,
      models
    });
  }
  ctx.llm.registerAdapter([...routes.keys()], new OpenAICompatAdapter(routes));
}
export {
  Config,
  apply,
  inject,
  name
};
