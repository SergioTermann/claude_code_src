import type { Command } from '../../commands.js'

const agentsPlatform = {
  type: 'local',
  name: 'agents-platform',
  description: 'Agents platform is unavailable in this recovered build.',
  supportsNonInteractive: false,
  load: async () => ({
    call: async () => ({ type: 'text', value: 'Unavailable in recovered build.' }),
  }),
} satisfies Command

export default agentsPlatform
