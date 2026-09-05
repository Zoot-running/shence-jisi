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
        const single = ctx.jisi.delegate(agent, work, { model: 'glm-4.5-air', provider: 'zhipu-official' })
        const singleReport = await single.report
        parts.push(`[delegate glm-4.5-air] ${singleReport.status}: ${singleReport.text.trim()}`)
        const reports = await ctx.jisi.fanout(agent, work, ['kimi-k2.6', 'glm-4.5-air'])
        reports.forEach((r, i) => {
          parts.push(`[fanout ${i === 0 ? 'kimi-k2.6' : 'glm-4.5-air'}] ${r.status}: ${r.text.trim()}`)
        })
        parts.push(`[listModels] ${JSON.stringify(await ctx.jisi.listModels())}`)
        return parts.join('\n')
      } catch (error) {
        return `PROBE-ERROR: ${String(error)}\n${(error as Error).stack ?? ''}`
      }
    },
  }))
}
