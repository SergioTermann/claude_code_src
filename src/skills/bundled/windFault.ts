import { selectLLMWikiProject } from '../../utils/llmwikiDiscovery.js'
import { registerBundledSkill } from '../bundledSkills.js'

export function registerWindFaultSkill(): void {
  registerBundledSkill({
    name: 'windfault',
    aliases: ['wind-fault', 'faultcode', 'fault-code'],
    description:
      'Diagnose wind turbine fault codes using the local LLMWiki/fault-code knowledge base.',
    whenToUse:
      'Use when the user asks about wind turbine fault codes, resetability, SCADA alarms, converter faults, pitch faults, or asks to search local wind-farm maintenance knowledge.',
    argumentHint: '[fault code or fault description]',
    allowedTools: [
      'Read',
      'Grep',
      'Glob',
      'Bash(npm run print:lmstudio:*)',
      'Bash(bin/windrise:*)',
      'Bash(rg:*)',
    ],
    userInvocable: true,
    async getPromptForCommand(args) {
      const project = await selectLLMWikiProject()
      const projectLine = project
        ? `Detected local knowledge project: \`${project.name}\` at \`${project.path}\`.`
        : 'No local LLMWiki/fault-code project was detected yet.'
      const query = args.trim()

      const prompt = `# Wind Fault Skill

Use the local wind turbine fault-code knowledge base to answer the user's request.

${projectLine}

## User Request

${query || 'No fault code or description was provided. Ask the user for the fault code, alarm name, turbine brand, or model.'}

## Workflow

1. If the request contains a numeric fault code, first run the deterministic local answer path:
   \`npm run print:lmstudio -- "/llmwiki ask <fault-code> --limit 4"\`
2. If the request is descriptive, search locally:
   \`npm run print:lmstudio -- "/llmwiki search <terms> --limit 6"\`
3. Prefer structured fields from the local answer: fault code, name, wind farm, brand, model, cause, handling steps, resetability, logic, and source path.
4. If multiple records disagree, call that out and cite each source path instead of merging them silently.
5. Do not invent causes, resetability, or repair steps that are not present in the retrieved local records.
6. Answer in Chinese by default and keep it operational: conclusion first, then cause, handling, reset/resetability, and source.

## Useful Commands

- Structured local answer: \`npm run print:lmstudio -- "/llmwiki ask 303804 --limit 4"\`
- Raw search: \`bin/windrise search <关键词>\`
- Read a cited file: \`npm run print:lmstudio -- "/llmwiki read <path>"\`
`

      return [{ type: 'text', text: prompt }]
    },
  })
}
