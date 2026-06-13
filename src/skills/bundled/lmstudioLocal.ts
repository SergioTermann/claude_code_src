import { registerBundledSkill } from '../bundledSkills.js'

export function registerLmStudioLocalSkill(): void {
  registerBundledSkill({
    name: 'lmstudiolocal',
    aliases: ['lmstudio-local', 'offline-lmstudio', 'local-lmstudio'],
    description:
      'Operate and diagnose the local LM Studio-backed offline Claude Code runtime.',
    whenToUse:
      'Use when the user asks about offline mode, LM Studio provider setup, local-only execution, doctor output, smoke tests, or whether the runtime is contacting remote services.',
    argumentHint: '[diagnostic question or task]',
    allowedTools: [
      'Read',
      'Grep',
      'Glob',
      'Bash(npm run print:lmstudio:*)',
      'Bash(npm run smoke:lmstudio)',
      'Bash(npm run smoke:llmwiki)',
      'Bash(npm run build)',
      'Bash(lmstudio list)',
      'Bash(ps:*)',
    ],
    userInvocable: true,
    async getPromptForCommand(args) {
      const prompt = `# LM Studio Local Skill

Help operate this project as a fully local LM Studio-backed coding assistant.

## User Request

${args.trim() || 'No specific diagnostic was provided. Run the local doctor checks and summarize offline readiness.'}

## Local Runtime Contract

- Provider should be \`lmstudio\`.
- \`LMSTUDIO_BASE_URL\` must be loopback only: \`http://127.0.0.1:1234\`, \`http://localhost:11434\`, or another localhost address.
- Do not recommend remote Claude, Anthropic, Bedrock, Vertex, OpenAI, or non-loopback LM Studio endpoints for offline mode.
- Prefer local commands and local files. Network-facing features should either be disabled or restricted to localhost.
- Treat LLMWiki and \`风机故障码\` as local knowledge sources.

## Verification Workflow

1. Check runtime status:
   \`npm run print:lmstudio -- /lmstudio\`
2. Check LLMWiki-only local knowledge:
   \`npm run smoke:llmwiki\`
3. Check LM Studio end-to-end:
   \`npm run smoke:lmstudio\`
4. Check build output:
   \`npm run build\`
5. If the user asks about privacy/offline behavior, verify that non-local URLs are rejected and explain which cloud features are intentionally unavailable offline.

## Answer Style

- Be explicit about what is fully local and what is intentionally unavailable offline.
- If a check fails, give the exact failing command, likely cause, and next command to run.
- Keep recommendations compatible with complete offline operation after models and dependencies are already present locally.
`

      return [{ type: 'text', text: prompt }]
    },
  })
}
