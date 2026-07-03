import { registerBundledSkill } from '../bundledSkills.js'

export function registerLocalVerifySkill(): void {
  registerBundledSkill({
    name: 'localverify',
    aliases: ['local-verify', 'offline-verify', 'local-smoke'],
    description:
      'Verify changes in this recovered Claude Code + SiliconFlow Windrise project.',
    whenToUse:
      'Use before handing off changes, after modifying SiliconFlow routing, LLMWiki, bundled skills, shell scripts, smoke tests, or provider/privacy gates.',
    argumentHint: '[what changed]',
    allowedTools: [
      'Read',
      'Grep',
      'Glob',
      'Bash(npm run smoke:offline)',
      'Bash(npm run smoke:skills)',
      'Bash(npm run smoke:llmwiki)',
      'Bash(npm run smoke:siliconflow)',
      'Bash(npm run smoke:lmstudio)',
      'Bash(npm run build)',
      'Bash(node --check:*)',
      'Bash(zsh -n:*)',
    ],
    userInvocable: true,
    async getPromptForCommand(args) {
      const prompt = `# Local Verify Skill

Verify changes in this SiliconFlow-first Windrise recovery project.

## Changed Area

${args.trim() || 'No change area was provided. Choose the narrowest relevant local verification path.'}

## Verification Matrix

- Skills changed:
  1. \`npm run smoke:skills\`
  2. \`npm run build\`
- LLMWiki or wind-fault knowledge changed:
  1. \`npm run smoke:llmwiki\`
  2. \`npm run eval:faults\`
  3. \`npm run print:siliconflow -- "/llmwiki ask 303804 --limit 2"\`
- Shell or Node helper scripts changed:
  1. \`node --check <script.mjs>\`
  2. \`zsh -n bin/windrise\` when shell entrypoints changed
  3. \`npm run smoke:llmwiki\`
- SiliconFlow provider or model routing changed:
  1. \`npm run build\`
  2. \`npm run smoke:siliconflow\`
- Broad local knowledge confidence without requiring a live SiliconFlow model:
  1. \`npm run smoke:offline\`
- Offline package readiness:
  1. \`npm run package:offline -- --check\`
  2. \`npm run package:offline -- --out /private/tmp/windrise-offline --tar\` when the user asks for a distributable package

## Rules

- Prefer checks that do not require internet unless the changed path is live SiliconFlow routing.
- Only \`smoke:siliconflow\` needs a valid \`SILICONFLOW_API_KEY\` and network access.
- If a check fails, report the exact command, the first actionable error, likely cause, and the smallest next fix.
- Do not claim full official Claude Code parity; distinguish local LLMWiki behavior from SiliconFlow model calls.
`

      return [{ type: 'text', text: prompt }]
    },
  })
}
