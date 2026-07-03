import { registerBundledSkill } from '../bundledSkills.js'

export function registerLmStudioLocalSkill(): void {
  registerBundledSkill({
    name: 'lmstudiolocal',
    aliases: ['lmstudio-local', 'offline-lmstudio', 'local-lmstudio'],
    description:
      'Operate and diagnose the SiliconFlow-backed Windrise runtime.',
    whenToUse:
      'Use when the user asks about SiliconFlow provider setup, model routing, doctor output, smoke tests, or whether Windrise is using local knowledge sources.',
    argumentHint: '[diagnostic question or task]',
    allowedTools: [
      'Read',
      'Grep',
      'Glob',
      'Bash(npm run print:siliconflow:*)',
      'Bash(npm run smoke:siliconflow)',
      'Bash(npm run print:lmstudio:*)',
      'Bash(npm run smoke:lmstudio)',
      'Bash(npm run smoke:llmwiki)',
      'Bash(npm run build)',
      'Bash(ps:*)',
    ],
    userInvocable: true,
    async getPromptForCommand(args) {
      const prompt = `# SiliconFlow Runtime Skill

Help operate this project as a SiliconFlow-backed Windrise assistant with local LLMWiki knowledge.

## User Request

${args.trim() || 'No specific diagnostic was provided. Run the provider doctor checks and summarize readiness.'}

## Local Runtime Contract

- Provider should be \`siliconflow\`.
- \`SILICONFLOW_API_KEY\` must be set for live model calls.
- \`SILICONFLOW_BASE_URL\` defaults to \`https://api.siliconflow.cn/v1\`.
- \`SILICONFLOW_MODEL\` defaults to \`Qwen/Qwen3.6-35B-A3B\`.
- Treat LLMWiki and \`风机故障码\` as local knowledge sources; these checks should still work without a live model API.

## Verification Workflow

1. Check runtime status:
   \`npm run print:siliconflow -- /lmstudio\`
2. Check LLMWiki-only local knowledge:
   \`npm run smoke:llmwiki\`
3. Check SiliconFlow end-to-end:
   \`npm run smoke:siliconflow\`
4. Check build output:
   \`npm run build\`
5. If the user asks about model routing, verify the provider and model shown by doctor or JSON init output.

## Answer Style

- Be explicit about what uses SiliconFlow and what uses local knowledge files.
- If a check fails, give the exact failing command, likely cause, and next command to run.
- Keep recommendations compatible with the current SiliconFlow-first setup.
`

      return [{ type: 'text', text: prompt }]
    },
  })
}
