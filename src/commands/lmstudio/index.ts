import type { Command } from '../../commands.js'

const lmstudio = {
  type: 'local',
  name: 'lmstudio',
  aliases: ['windrise'],
  description: 'Diagnose the local LM Studio and LLMWiki setup',
  argumentHint: 'doctor',
  supportsNonInteractive: true,
  load: () => import('./lmstudio.js'),
} satisfies Command

export default lmstudio
