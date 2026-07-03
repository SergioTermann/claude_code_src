import { registerBundledSkill } from '../bundledSkills.js'
import { buildWorkOrderGeneratePrompt } from './workOrderPrompt.js'

export function registerWorkOrderGenerateSkill(): void {
  registerBundledSkill({
    name: 'workordergenerate',
    aliases: [
      'workorder-gen',
      'workordergen',
      'smartworkorder',
      'smart-workorder',
      'gongdan',
    ],
    description:
      'Generate Windrise smart work orders from fault conversations, SCADA alarms, field feedback, LLMWiki evidence, or troubleshooting conclusions. Use when the user asks to create,整理,生成,填写,派发, or summarize an intelligent work order, maintenance ticket, dispatch sheet, defect record, repair task, or field service order.',
    whenToUse:
      'Use when the user asks for 智能工单, 工单生成, 派单, 缺陷单, 检修任务单, 现场处理单, 维修记录, 故障闭环单, or wants to turn a Windrise diagnostic answer/conversation into an executable work order.',
    argumentHint: '[fault context, alarm, or conversation_id]',
    allowedTools: [
      'Read',
      'Write',
      'Edit',
      'Grep',
      'Glob',
      'Bash(rg:*)',
      'Bash(ls:*)',
      'Bash(mkdir -p generated-knowledge/work-orders)',
    ],
    userInvocable: true,
    async getPromptForCommand(args) {
      return [{ type: 'text', text: buildWorkOrderGeneratePrompt(args) }]
    },
  })
}
