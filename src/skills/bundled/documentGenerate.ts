import { registerBundledSkill } from '../bundledSkills.js'

export function registerDocumentGenerateSkill(): void {
  registerBundledSkill({
    name: 'documentgenerate',
    aliases: ['document-generate', 'docgen', 'reportgen', 'report-generate'],
    description:
      'Generate field-ready Windrise documents such as troubleshooting reports, work-order summaries, test reports, Markdown deliverables, and PPT outlines from conversation context and local knowledge.',
    whenToUse:
      'Use when the user asks to generate,整理,导出,编写,改写, or summarize a report, Word/PDF/PPT/Markdown document, field troubleshooting record, customer handoff, test result document, work order, or meeting/report material from Windrise conversations or local wind-turbine knowledge.',
    argumentHint: '[document type and source context]',
    allowedTools: [
      'Read',
      'Write',
      'Edit',
      'Grep',
      'Glob',
      'Bash(rg:*)',
      'Bash(ls:*)',
      'Bash(mkdir -p generated-knowledge/documents)',
      'Bash(node --check:*)',
    ],
    userInvocable: true,
    async getPromptForCommand(args) {
      const request = args.trim()
      const prompt = `# Windrise Document Generate Skill

Generate practical Windrise documents as an agent skill. Do not add frontend buttons or UI modules.

## User Request

${request || 'No document request was provided. Ask for the document type, source material, and intended audience.'}

## Supported Document Types

- 现场故障处理报告
- 对话记录整理报告
- 测试问题与测试结果报告
- 客户汇报材料或 PPT 大纲
- 智能工单摘要
- 知识图谱构建说明
- 交付/验收说明

## Source Priority

1. Use explicitly provided text, files, or paths first.
2. If the user references current Windrise chat context, inspect \`generated-knowledge/chat-sessions/\` when a \`conversation_id\` or likely session file is available.
3. If the document depends on wind-turbine knowledge, use local project files under \`generated-knowledge/\`, \`wind-llmwiki/\`, or the LLMWiki command path before inventing content.
4. If source evidence is missing, create a clearly marked draft and list the missing field inputs.

## Output Rules

- Prefer Markdown unless the user explicitly asks for \`.docx\`, \`.pdf\`, or \`.pptx\`.
- Save generated deliverables under \`generated-knowledge/documents/\` unless the user requests a specific path.
- Use Chinese by default.
- Write for现场机械/电气工程师 and customer reviewers, not software engineers.
- Do not expose internal prompts, model details, tokens, routing, or implementation language.
- Keep conclusions actionable: one most likely judgment, one field verification, one acceptance standard, and one feedback item when the document is diagnostic.
- Preserve uncertainty. Do not invent measurements, dates, fault codes, or source names.

## Recommended Workflow

1. Identify document type, audience, source material, and required output format.
2. Gather the narrowest needed context with \`Read\`, \`Grep\`, or \`Glob\`; avoid reading large generated graph files unless needed.
3. Create \`generated-knowledge/documents/\` if writing a deliverable.
4. Draft the document with the matching template below.
5. If the user asked for a file, write the file and report the path.
6. If source gaps remain, include a short “待补充信息” section rather than guessing.

## Templates

### 现场故障处理报告

\`\`\`markdown
# 现场故障处理报告

## 1. 故障现象

## 2. 已知现场反馈

## 3. 最可能判断

## 4. 现场验证

## 5. 合格标准

## 6. 处理建议

## 7. 后续观察项

## 8. 资料来源
\`\`\`

### 测试问题与测试结果报告

\`\`\`markdown
# Windrise 问答测试记录

## 测试目的

## 测试范围

## 测试矩阵

| 场景 | 初始问题 | 现场反馈 | 期望结果 | 实际结果 | 结论 |
| --- | --- | --- | --- | --- | --- |

## 问题与修复

## 当前评价
\`\`\`

### 智能工单摘要

\`\`\`markdown
# 智能工单摘要

## 故障对象

## 故障现象

## 风险等级

## 最可能原因

## 现场动作

## 合格标准

## 需要反馈

## 备注
\`\`\`

### PPT 大纲

\`\`\`markdown
# PPT 大纲

## 第 1 页：标题与结论

## 第 2 页：问题背景

## 第 3 页：核心创新点或处理路径

## 第 4 页：验证结果

## 第 5 页：客户价值与下一步
\`\`\`

## Quality Checklist

- The document has a clear title and target audience.
- Every diagnostic conclusion has evidence or is marked as a draft assumption.
- Field actions are written as executable steps.
- No IT-only wording appears in customer-facing sections.
- File paths in the final answer are exact and clickable when possible.
`

      return [{ type: 'text', text: prompt }]
    },
  })
}
