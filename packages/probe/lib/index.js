// src/index.ts
import { defineTool } from "@deepseek-ai/dsh-tools";
var name = "shence-jisi-probe";
var inject = ["tools", "jisi", "subagents"];
function apply(ctx) {
  ctx.tools.register(defineTool({
    name: "jisi_probe",
    description: "Run the jisi channel probe: delegate a trivial task to another model and fan out to two models in parallel. Returns every raw report for inspection.",
    parameters: {},
    output: {
      schema: { type: "string" },
      render: (_args, value) => [{ type: "text", text: value }]
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const agent = exec.agent;
      if (agent === void 0) throw new Error("jisi_probe requires a calling agent");
      try {
        const work = { prompt: "\u8BF7\u53EA\u56DE\u590D\u4E00\u4E2A\u5355\u8BCD\uFF1APONG" };
        const parts = [];
        parts.push(`[provider spawn?] ${ctx.subagents.getProvider("spawn") !== void 0}`);
        const single = ctx.jisi.delegate(agent, work, { model: "glm-4.5-air", provider: "zhipu-official", background: false });
        const singleReport = await single.report;
        parts.push(`[delegate glm-4.5-air] ${singleReport.status}: ${singleReport.text.trim()}`);
        const reports = await ctx.jisi.fanout(agent, work, ["kimi-k2.6", "glm-4.5-air"], { background: false });
        reports.forEach((r, i) => {
          parts.push(`[fanout ${i === 0 ? "kimi-k2.6" : "glm-4.5-air"}] ${r.status}: ${r.text.trim()}`);
        });
        parts.push(`[listModels] ${JSON.stringify(await ctx.jisi.listModels())}`);
        return parts.join("\n");
      } catch (error) {
        return `PROBE-ERROR: ${String(error)}
${error.stack ?? ""}`;
      }
    }
  }));
}
export {
  apply,
  inject,
  name
};
