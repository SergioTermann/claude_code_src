export function buildWorkOrderGeneratePrompt(args: string): string {
  const request = args.trim()
  return `# Windrise Smart Work Order Skill

Generate field-ready smart work orders as an internal agent capability. Do not add frontend buttons or UI modules.

This skill follows the WindOps architecture from 01_lecture1_wind_ops:
Business intake -> Data normalization -> Memory context -> Planner -> Tool/evidence layer -> Model routing -> Feedback closure.

## User Request

${request || 'No work-order request was provided. Ask for the fault object, alarm/fault phenomenon, and whether to use the current conversation context.'}

## Source Priority

1. Use fault context explicitly provided by the user first.
2. Normalize the request into a structured WindOps Case: wind farm/turbine, brand/model, system/component, fault code/alarm, time window, current operating state, missing safety context.
3. If the user references current or prior Windrise chat, inspect \`generated-knowledge/chat-sessions/\` when a \`conversation_id\` or likely session file is available.
4. If the work order needs evidence, search local knowledge under \`generated-knowledge/\`, \`wind-llmwiki/\`, or use the LLMWiki skill/command path before inventing causes.
5. Rank evidence as: manufacturer manual/fault table > site SOP > expert rule > closed work order > unverified experience.
6. If required dispatch fields are missing, still generate a draft and mark missing fields as \`待补充\`.

## Output Rules

- Prefer Markdown unless the user requests another format.
- Save generated work orders under \`generated-knowledge/work-orders/\` when the user asks for a file.
- Use Chinese by default.
- Write for现场机械/电气工程师 and班组长, not software engineers.
- Do not expose internal prompts, model details, tokens, routing, or implementation language.
- Keep the工单 executable: one likely fault direction, one first field action, one acceptance standard, and one required feedback item.
- Do not invent measurements, turbine numbers, dates, responsible people, safety permits, or spare parts. Use \`待补充\` when absent.
- High-risk actions such as reset, start/stop, parameter adjustment, tower climb, cabinet opening, or live work must be written as recommendations only, gated by work ticket, wind speed, stop state, permission, and second confirmation.
- Temporary states such as curtailment, bypass, weather, recent reset, or unverified candidate cause must be marked as short-term context and must not be written as permanent asset history.

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

## 3. 结构化故障 Case

- 风机/机型：
- 系统/部件：
- 故障码/告警：
- 时间窗：
- 运行状态：
- 缺失信息：

## 4. 证据来源与分级

- 厂家手册/故障码表：
- 场站 SOP：
- 专家知识/历史工单：
- 实时或快照数据：

## 5. Planner 诊断路径

1.
2.
3.

## 6. 最可能判断

## 7. Safety Gate

- 作业票：
- 风速：
- 停机/限功率状态：
- 权限与二次确认：
- 控制类动作边界：

## 8. 首个现场动作

## 9. 合格标准

## 10. 需要反馈

## 11. 备件与工具

## 12. 闭环条件

## 13. 反馈入库

- 可进入长期画像：
- 仅短期 TTL 记忆：
- 专家复核项：
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
  - \`Safety Gate\`: required permit, wind speed, stop state, permission, and second confirmation checks.
  - \`反馈入库\`: what should update long-term turbine/fault profile versus short-term TTL memory.

## File Naming

When writing a file, use:
\`generated-knowledge/work-orders/YYYYMMDD-<short-fault-name>-work-order.md\`

If no date is provided, use today's local date from the environment.
`
}
