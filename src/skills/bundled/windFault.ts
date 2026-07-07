import { selectLLMWikiProject } from '../../utils/llmwikiDiscovery.js'
import { registerBundledSkill } from '../bundledSkills.js'

export function registerWindFaultSkill(): void {
  registerBundledSkill({
    name: 'windfault',
    aliases: ['wind-fault', 'faultcode', 'fault-code'],
    description:
      'Diagnose wind turbine faults with WindOps layered architecture, local LLMWiki evidence, safety gates, and work-order closure.',
    whenToUse:
      'Use when the user asks about wind turbine fault codes, resetability, SCADA/CMS alarms, converter faults, pitch faults, yaw/hydraulic faults, maintenance actions, safety checks, or local wind-farm maintenance knowledge.',
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

Use the local wind turbine fault-code knowledge base and the WindOps layered architecture to answer the user's request. This is a backend/agent architecture workflow, not a UI/page workflow.

${projectLine}

## User Request

${query || 'No fault code or description was provided. Ask the user for the fault code, alarm name, turbine brand, or model.'}

## Workflow

1. Normalize the user request into a structured WindOps Case before answering:
   - turbine_id / wind farm / brand / model
   - system / component / fault_code / alarm name
   - time window / current operating state / missing safety context
2. If the request contains a numeric fault code, first run the deterministic local answer path:
   \`npm run print:lmstudio -- "/llmwiki ask <fault-code> --limit 4"\`
3. If the request is descriptive, search locally:
   \`npm run print:lmstudio -- "/llmwiki search <terms> --limit 6"\`
4. For multi-step diagnostic requests, use Plan-and-Execute:
   - Planner: define the next diagnostic path from Case + retrieved evidence.
   - Executor: propose only read-only data pulls or field verification steps.
   - Safety Gate: block or caveat reset/start-stop/parameter/tower/cabinet/live-work actions unless work ticket, wind speed, stop state, permission, and second confirmation are present.
5. Prefer structured fields from the local answer: fault code, name, wind farm, brand, model, cause, handling steps, resetability, logic, and source path.
6. If multiple records disagree, call that out and cite each source path instead of merging them silently.
7. Do not invent causes, resetability, spare-part models, measurements, permissions, or repair steps that are not present in the retrieved local records.
8. Answer in Chinese by default and keep it operational: conclusion first, structured Case gaps, Safety Gate if relevant, one next action, feedback required, and source.

## WindOps Architecture Requirements

- Data layer first: align fault code, turbine, component, time window, model/vendor terminology, and operating state before generation.
- Memory layer: use turbine profile, fault profile, current work memory, and trace memory only as evidence; do not let temporary states permanently pollute asset history.
- LLMWiki: exact fault-code/BOM/point-name lookup plus semantic search plus graph/pathway evidence. Rank evidence as manufacturer manual/fault table > site SOP > expert rule > closed work order > unverified experience.
- Tool boundary: CMS, SCADA, EAM/CMMS, spare parts, weather, ticketing, and alarm tools are read-only or draft-generating unless an external approved execution chain exists.
- Feedback layer: when recommending closure, specify what work-order result, expert correction, recurrence, downtime, and spare-part outcome should be captured.

## Useful Commands

- Structured local answer: \`npm run print:lmstudio -- "/llmwiki ask 303804 --limit 4"\`
- Raw search: \`bin/windrise search <关键词>\`
- Read a cited file: \`npm run print:lmstudio -- "/llmwiki read <path>"\`
`

      return [{ type: 'text', text: prompt }]
    },
  })
}
