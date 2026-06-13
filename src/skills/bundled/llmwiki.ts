import { access, readdir, readFile } from 'fs/promises'
import { dirname, join, resolve } from 'path'
import { getProjectRoot } from '../../bootstrap/state.js'
import { getCwd } from '../../utils/cwd.js'
import {
  resolveLLMWikiProject,
  type LLMWikiProject,
} from '../../utils/llmwikiDiscovery.js'
import { registerBundledSkill } from '../bundledSkills.js'

type FileSnapshot = {
  files?: Record<string, { size?: number; mtimeMs?: number }>
  updatedAt?: number
  version?: number
}

type ConversationSummary = {
  id?: string
  title?: string
  createdAt?: number
  updatedAt?: number
}

const MAX_TOP_LEVEL_DIRS = 12
const MAX_RECENT_CONVERSATIONS = 5

export function registerLlmWikiSkill(): void {
  registerBundledSkill({
    name: 'llmwiki',
    aliases: ['llm-wiki'],
    description:
      'Search and use the local .llm-wiki project or local text knowledge directory, including indexed source files, snapshots, and saved LLM Wiki conversations.',
    whenToUse:
      'Use when the user asks to consult llmwiki, llm-wiki, local wiki, project knowledge base, indexed documents, fault-code documents, or prior LLM Wiki conversations.',
    allowedTools: [
      'Read',
      'Grep',
      'Glob',
      'Bash(rg:*)',
      'Bash(jq:*)',
      'Bash(find:*)',
      'Bash(ls:*)',
    ],
    argumentHint: '[question or search terms]',
    userInvocable: true,
    async getPromptForCommand(args) {
      const wikiDir = await findLlmWikiDir()
      const resolution = await resolveLLMWikiProject().catch(() => null)
      const overview = wikiDir
        ? await buildWikiOverview(wikiDir)
        : resolution?.project
          ? await buildKnowledgeDirectoryOverview(
              resolution.project,
              resolution.source,
            )
        : buildMissingWikiOverview()

      const prompt = `# LLM Wiki

Use the user's local LLM Wiki knowledge base to answer the request.

${overview}

## User Request

${args || 'No specific query was provided. Inspect the LLM Wiki overview and ask what the user wants to search for.'}

## Workflow

1. If an LLM Wiki directory or local text knowledge directory was found, treat it as the primary knowledge source for this request.
2. Prefer the local slash command first: \`npm run print:lmstudio -- "/llmwiki ask <query> --limit 4"\` for direct answers, or \`/llmwiki search <query>\` for evidence.
3. Search \`file-snapshot.json\` for likely source files before reading large documents when a standard \`.llm-wiki\` directory exists. Prefer \`jq\`, \`rg\`, \`Grep\`, and \`Read\` over broad full-file reads.
3. Source files listed in \`file-snapshot.json\` are relative to the project root that owns the \`.llm-wiki\` directory. Read those files directly when they are relevant.
4. Use \`.llm-wiki/conversations.json\` and \`.llm-wiki/chats/*.json\` only when the user asks about prior LLM Wiki chats or when source documents are insufficient.
5. Keep answers grounded in the retrieved files. Mention the specific file paths used.
6. If no project was found, explain that the current project does not expose one and suggest running from the project root, setting \`LLMWIKI_PROJECT\` to a project/text-corpus root, or setting \`LLMWIKI_DIR\` to a \`.llm-wiki\` directory path.

## Useful Commands

- List indexed paths: \`jq -r '.files | keys[]' .llm-wiki/file-snapshot.json\`
- Search indexed paths: \`jq -r '.files | keys[]' .llm-wiki/file-snapshot.json | rg '<terms>'\`
- Inspect conversations: \`jq -r '.[] | [.updatedAt, .title, .id] | @tsv' .llm-wiki/conversations.json\`
- Structured local answer: \`npm run print:lmstudio -- "/llmwiki ask <query> --limit 4"\`
- Raw local search: \`npm run print:lmstudio -- "/llmwiki search <query> --limit 8"\`
`

      return [{ type: 'text', text: prompt }]
    },
  })
}

async function buildKnowledgeDirectoryOverview(
  project: LLMWikiProject,
  source: string,
): Promise<string> {
  let entries = []
  try {
    entries = await readdir(project.path, { withFileTypes: true })
  } catch {
    entries = []
  }

  const visible = entries.filter(entry => !entry.name.startsWith('.'))
  const topDirectories = visible
    .filter(entry => entry.isDirectory())
    .slice(0, MAX_TOP_LEVEL_DIRS)
    .map(entry => `\`${entry.name}\``)
    .join(', ')
  const topFiles = visible
    .filter(entry => entry.isFile())
    .slice(0, MAX_TOP_LEVEL_DIRS)
    .map(entry => `\`${entry.name}\``)
    .join(', ')

  return `## Detected Local Knowledge Directory

- Project name: \`${project.name}\`
- Project root: \`${project.path}\`
- Resolution source: \`${source}\`
- Top directories: ${topDirectories || 'none'}
- Top files: ${topFiles || 'none'}

This project does not need a standard \`.llm-wiki\` directory. Use the local \`/llmwiki\` command path for search, read, tree, and structured ask.
`
}

async function findLlmWikiDir(): Promise<string | null> {
  const envWikiDir = process.env.LLMWIKI_DIR
  if (envWikiDir && (await isLlmWikiDir(resolve(envWikiDir)))) {
    return resolve(envWikiDir)
  }

  const envProjectDir = process.env.LLMWIKI_PROJECT
  if (envProjectDir) {
    const candidate = join(resolve(envProjectDir), '.llm-wiki')
    if (await isLlmWikiDir(candidate)) {
      return candidate
    }
  }

  const roots = uniquePaths([getCwd(), getProjectRoot()])
  for (const root of roots) {
    const found = await findLlmWikiDirFrom(root)
    if (found) return found
  }

  return null
}

async function findLlmWikiDirFrom(startDir: string): Promise<string | null> {
  let current = resolve(startDir)

  while (true) {
    const candidate = join(current, '.llm-wiki')
    if (await isLlmWikiDir(candidate)) {
      return candidate
    }

    const parent = dirname(current)
    if (parent === current) {
      return null
    }
    current = parent
  }
}

async function isLlmWikiDir(dir: string): Promise<boolean> {
  try {
    await access(join(dir, 'project.json'))
    await access(join(dir, 'file-snapshot.json'))
    return true
  } catch {
    return false
  }
}

async function buildWikiOverview(wikiDir: string): Promise<string> {
  const [project, snapshot, conversations] = await Promise.all([
    readJson<Record<string, unknown>>(join(wikiDir, 'project.json')),
    readJson<FileSnapshot>(join(wikiDir, 'file-snapshot.json')),
    readJson<ConversationSummary[]>(join(wikiDir, 'conversations.json')),
  ])

  const projectRoot = dirname(wikiDir)
  const files = snapshot?.files ?? {}
  const paths = Object.keys(files)
  const topLevelDirs = summarizeTopLevelDirs(paths)
  const recentConversations = summarizeRecentConversations(conversations ?? [])

  return `## Detected LLM Wiki

- Wiki directory: \`${wikiDir}\`
- Project root: \`${projectRoot}\`
- Project id: \`${String(project?.id ?? 'unknown')}\`
- Snapshot version: \`${String(snapshot?.version ?? 'unknown')}\`
- Snapshot updated: ${formatTimestamp(snapshot?.updatedAt)}
- Indexed files: ${paths.length}
- Top indexed areas: ${topLevelDirs || 'none'}
- Conversations: ${conversations?.length ?? 0}
${recentConversations ? `- Recent conversations:\n${recentConversations}` : ''}
`
}

function buildMissingWikiOverview(): string {
  return `## Detected LLM Wiki

No \`.llm-wiki\` directory was found from \`LLMWIKI_DIR\`, \`LLMWIKI_PROJECT\`, the current working directory, or the project root.
`
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return null
  }
}

function summarizeTopLevelDirs(paths: string[]): string {
  const counts = new Map<string, number>()
  for (const path of paths) {
    const top = path.includes('/') ? path.slice(0, path.indexOf('/')) : path
    counts.set(top, (counts.get(top) ?? 0) + 1)
  }

  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_TOP_LEVEL_DIRS)
    .map(([name, count]) => `\`${name}\` (${count})`)
    .join(', ')
}

function summarizeRecentConversations(
  conversations: ConversationSummary[],
): string {
  return conversations
    .slice()
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, MAX_RECENT_CONVERSATIONS)
    .map(
      conversation =>
        `  - ${formatTimestamp(conversation.updatedAt)} ${conversation.title ?? '(untitled)'} \`${conversation.id ?? 'unknown'}\``,
    )
    .join('\n')
}

function formatTimestamp(value: number | undefined): string {
  if (!value) return 'unknown'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'unknown'
  return date.toISOString()
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.filter(Boolean).map(path => resolve(path)))]
}
