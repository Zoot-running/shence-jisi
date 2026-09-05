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
        const effort = ctx.jisi.delegate(agent, work, { model: "glm-4.6", reasoningEffort: "max", background: false });
        const effortReport = await effort.report;
        parts.push(`[delegate glm-4.6 effort=max] ${effortReport.status}: ${effortReport.text.trim()}`);
        const kimiPlain = ctx.jisi.delegate(agent, work, { model: "kimi-k2.6", background: false });
        const kimiPlainReport = await kimiPlain.report;
        parts.push(`[delegate kimi-k2.6] ${kimiPlainReport.status}: ${kimiPlainReport.text.trim()}`);
        const kimiHigh = ctx.jisi.delegate(agent, work, { model: "kimi-k2.6", reasoningEffort: "high", background: false });
        const kimiHighReport = await kimiHigh.report;
        parts.push(`[delegate kimi-k2.6 effort=high] ${kimiHighReport.status}: ${kimiHighReport.text.trim()}`);
        const k3 = ctx.jisi.delegate(agent, work, { model: "kimi-k3", background: false });
        const k3Report = await k3.report;
        parts.push(`[delegate kimi-k3] ${k3Report.status}: ${k3Report.text.trim()}`);
        const glm53 = ctx.jisi.delegate(agent, work, { model: "glm-5.3", reasoningEffort: "max", background: false });
        const glm53Report = await glm53.report;
        parts.push(`[delegate glm-5.3 effort=max] ${glm53Report.status}: ${glm53Report.text.trim()}`);
        const dsFlash = ctx.jisi.delegate(agent, work, { model: "deepseek-v4-flash", reasoningEffort: "low", background: false });
        const dsFlashReport = await dsFlash.report;
        parts.push(`[delegate deepseek-v4-flash effort=low] ${dsFlashReport.status}: ${dsFlashReport.text.trim()}`);
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
