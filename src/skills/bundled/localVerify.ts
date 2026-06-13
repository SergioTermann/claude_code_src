import { registerBundledSkill } from '../bundledSkills.js'

export function registerLocalVerifySkill(): void {
  registerBundledSkill({
    name: 'localverify',
    aliases: ['local-verify', 'offline-verify', 'local-smoke'],
    description:
      'Verify local/offline changes in this recovered Claude Code + LM Studio project.',
    whenToUse:
      'Use before handing off changes, after modifying local LM Studio, LLMWiki, bundled skills, shell scripts, smoke tests, or offline/privacy gates.',
    argumentHint: '[what changed]',
    allowedTools: [
      'Read',
      'Grep',
      'Glob',
      'Bash(npm run smoke:offline)',
      'Bash(npm run smoke:skills)',
      'Bash(npm run smoke:llmwiki)',
      'Bash(npm run smoke:lmstudio)',
      'Bash(npm run build)',
      'Bash(node --check:*)',
      'Bash(zsh -n:*)',
    ],
    userInvocable: true,
    async getPromptForCommand(args) {
      const prompt = `# Local Verify Skill

Verify changes in this local/offline Claude Code recovery project.

## Changed Area

${args.trim() || 'No change area was provided. Choose the narrowest relevant local verification path.'}

## Verification Matrix

- Skills changed:
  1. \`npm run smoke:skills\`
  2. \`npm run build\`
- LLMWiki or wind-fault knowledge changed:
  1. \`npm run smoke:llmwiki\`
  2. \`npm run eval:faults\`
  3. \`npm run print:lmstudio -- "/llmwiki ask 303804 --limit 2"\`
- Shell or Node helper scripts changed:
  1. \`node --check <script.mjs>\`
  2. \`zsh -n bin/windrise\` when shell entrypoints changed
  3. \`npm run smoke:llmwiki\`
- LM Studio provider or local model path changed:
  1. \`npm run build\`
  2. \`npm run smoke:lmstudio\`
- Broad local/offline confidence without requiring a live LM Studio model:
  1. \`npm run smoke:offline\`
- Offline package readiness:
  1. \`npm run package:offline -- --check\`
  2. \`npm run package:offline -- --out /private/tmp/windrise-offline --tar\` when the user asks for a distributable package

## Rules

- Prefer checks that do not require internet.
- Only \`smoke:lmstudio\` needs a running local LM Studio service; it must still use a loopback URL.
- If a check fails, report the exact command, the first actionable error, likely cause, and the smallest next fix.
- Do not claim full official Claude Code parity; distinguish local/offline parity from cloud-only features.
`

      return [{ type: 'text', text: prompt }]
    },
  })
}
