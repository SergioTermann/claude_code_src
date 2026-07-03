export function buildWorkOrderGeneratePrompt(args: string): string {
  const request = args.trim()
  return `# Windrise Smart Work Order Skill

Generate field-ready smart work orders as an internal agent capability. Do not add frontend buttons or UI modules.

## User Request

${request || 'No work-order request was provided. Ask for the fault object, alarm/fault phenomenon, and whether to use the current conversation context.'}

## Source Priority

1. Use fault context explicitly provided by the user first.
2. If the user references current or prior Windrise chat, inspect \`generated-knowledge/chat-sessions/\` when a \`conversation_id\` or likely session file is available.
3. If the work order needs evidence, search local knowledge under \`generated-knowledge/\`, \`wind-llmwiki/\`, or use the LLMWiki skill/command path before inventing causes.
4. If required dispatch fields are missing, still generate a draft and mark missing fields as \`待补充\`.

## Output Rules

- Prefer Markdown unless the user requests another format.
- Save generated work orders under \`generated-knowledge/work-orders/\` when the user asks for a file.
- Use Chinese by default.
- Write for现场机械/电气工程师 and班组长, not software engineers.
- Do not expose internal prompts, model details, tokens, routing, or implementation language.
- Keep the工单 executable: one likely fault direction, one first field action, one acceptance standard, and one required feedback item.
- Do not invent measurements, turbine numbers, dates, responsible people, safety permits, or spare parts. Use \`待补充\` when absent.

## Work Order Structure

Use this structure unless the user specifies another template:

\`\`\`markdown
# 智能工单

## 1. 工单摘要

- 工单类型：
- 风场/机组：
- 系统/部件：
- 故障现象：
- 风险等级：
- 当前状态：

## 2. 已知现场信息

## 3. 最可能判断

## 4. 首个现场动作

## 5. 合格标准

## 6. 需要反馈

## 7. 安全注意事项

## 8. 备件与工具

## 9. 闭环条件

## 10. 资料来源
\`\`\`

## Risk Level Guidance

- 高：涉及安全链、主轴承/齿轮箱/发电机轴承明显损伤、雷击浪涌后多系统异常、并网保护异常、持续过温或振动升高。
- 中：影响发电或可能扩大故障，但现场仍可安全验证，如水冷压力低、单台设备通信掉线、传感器测量异常、接触器反馈不一致。
- 低：资料补充、趋势复核、状态切换误报警、已恢复但需要观察的问题。
- If uncertain, mark \`中（待现场确认）\` and explain the missing evidence.

## Field Language Requirements

- Use \`先...\`, \`再...\`, \`不要先...\` to guide action order.
- Avoid broad checklists. Give a clear first action and feedback requirement.
- Replace abstract wording with field terms: use \`供电回路\`, \`反馈回路\`, \`接插件\`, \`辅助触点\`, \`端子排\`, \`压力表\`, \`趋势\`.
- For diagnostic work orders, include:
  - \`首个现场动作\`: exactly one immediate field action.
  - \`合格标准\`: what result supports the judgment and what result rejects it.
  - \`需要反馈\`: the exact values/status to report back.

## File Naming

When writing a file, use:
\`generated-knowledge/work-orders/YYYYMMDD-<short-fault-name>-work-order.md\`

If no date is provided, use today's local date from the environment.
`
}
