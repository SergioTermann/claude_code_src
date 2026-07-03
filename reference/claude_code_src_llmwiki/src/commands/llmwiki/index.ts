import type { Command } from '../../commands.js'

const llmwiki = {
  type: 'local',
  name: 'llmwiki',
  aliases: ['wiki'],
  description: 'Search and read the local LLMWiki project',
  argumentHint: '[projects|tree|search <query>|read <path>]',
  supportsNonInteractive: true,
  load: () => import('./llmwiki.js'),
} satisfies Command

export default llmwiki
