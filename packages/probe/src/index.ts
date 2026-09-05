/**
 * 集思 L1 集成探针：注册 jisi_probe 工具。
 * 模型调用该工具时：
 *  1. delegate 一个"回复 PONG"的工作给 glm-4.5-air（按次换模型验证）；
 *  2. fanout 同一工作给两个模型（kimi-k2.6 + glm-4.5-air）；
 *  3. 把全部报告原样交回模型。
 * @module @shence/jisi-probe
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'shence-jisi-probe'
export const inject = ['tools', 'jisi', 'subagents']

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'jisi_probe',
    description: 'Run the jisi channel probe: delegate a trivial task to another model and fan out to two models in parallel. Returns every raw report for inspection.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('jisi_probe requires a calling agent')
      try {
        const work = { prompt: '请只回复一个单词：PONG' }
        const parts: string[] = []
        parts.push(`[provider spawn?] ${ctx.subagents.getProvider('spawn') !== undefined}`)
        const single = ctx.jisi.delegate(agent, work, { model: 'glm-4.5-air', provider: 'zhipu-official', background: false })
        const singleReport = await single.report
        parts.push(`[delegate glm-4.5-air] ${singleReport.status}: ${singleReport.text.trim()}`)
        const reports = await ctx.jisi.fanout(agent, work, ['kimi-k2.6', 'glm-4.5-air'], { background: false })
        reports.forEach((r, i) => {
          parts.push(`[fanout ${i === 0 ? 'kimi-k2.6' : 'glm-4.5-air'}] ${r.status}: ${r.text.trim()}`)
        })
        // 按次思考强度：glm-4.6 + max（thinking 参数经 llm-openai-compat 路由映射）。
        const effort = ctx.jisi.delegate(agent, work, { model: 'glm-4.6', reasoningEffort: 'max', background: false })
        const effortReport = await effort.report
        parts.push(`[delegate glm-4.6 effort=max] ${effortReport.status}: ${effortReport.text.trim()}`)
        // kimi 基准：无 effort 与 effort=high 两条路径（供路由/诊断对照）。
        const kimiPlain = ctx.jisi.delegate(agent, work, { model: 'kimi-k2.6', background: false })
        const kimiPlainReport = await kimiPlain.report
        parts.push(`[delegate kimi-k2.6] ${kimiPlainReport.status}: ${kimiPlainReport.text.trim()}`)
        const kimiHigh = ctx.jisi.delegate(agent, work, { model: 'kimi-k2.6', reasoningEffort: 'high', background: false })
        const kimiHighReport = await kimiHigh.report
        parts.push(`[delegate kimi-k2.6 effort=high] ${kimiHighReport.status}: ${kimiHighReport.text.trim()}`)
        // 新一代模型路由：kimi-k3 / deepseek-v4-flash（模型名反查 provider）。
        const k3 = ctx.jisi.delegate(agent, work, { model: 'kimi-k3', background: false })
        const k3Report = await k3.report
        parts.push(`[delegate kimi-k3] ${k3Report.status}: ${k3Report.text.trim()}`)
        const dsFlash = ctx.jisi.delegate(agent, work, { model: 'deepseek-v4-flash', reasoningEffort: 'low', background: false })
        const dsFlashReport = await dsFlash.report
        parts.push(`[delegate deepseek-v4-flash effort=low] ${dsFlashReport.status}: ${dsFlashReport.text.trim()}`)
        // 并发对照：3× deepseek-v4-pro+max 同时派（hard 题主力模型并发验证）。
        const concurrent = await ctx.jisi.fanout(agent, work, ['deepseek-v4-pro', 'deepseek-v4-pro', 'deepseek-v4-pro'], { reasoningEffort: 'max', background: false })
        concurrent.forEach((r, i) => {
          parts.push(`[concurrent deepseek-v4-pro #${i + 1}] ${r.status}: ${r.text.trim()}`)
        })
        // 智谱余额哨兵（余额不足时 failed，提示充值）。
        const glm53 = ctx.jisi.delegate(agent, work, { model: 'glm-5.3', reasoningEffort: 'max', background: false })
        const glm53Report = await glm53.report
        parts.push(`[delegate glm-5.3 effort=max] ${glm53Report.status}: ${glm53Report.text.trim()}`)
        parts.push(`[listModels] ${JSON.stringify(await ctx.jisi.listModels())}`)
        return parts.join('\n')
      } catch (error) {
        return `PROBE-ERROR: ${String(error)}\n${(error as Error).stack ?? ''}`
      }
    },
  }))
}
