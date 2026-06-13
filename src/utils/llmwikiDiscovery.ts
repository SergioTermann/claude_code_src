import { existsSync } from 'fs'
import { readdir, readFile, stat } from 'fs/promises'
import { homedir } from 'os'
import { basename, dirname, join, resolve } from 'path'
import { getCwd } from './cwd.js'

export type LLMWikiProject = {
  id?: string
  name: string
  path: string
  lastOpened?: number
}

type AppState = {
  lastProject?: LLMWikiProject
  recentProjects?: LLMWikiProject[]
  projectRegistry?: Record<string, LLMWikiProject>
}

export type LLMWikiProjectResolution = {
  project: LLMWikiProject | null
  source:
    | 'explicit'
    | 'LLMWIKI_PROJECT'
    | 'LLMWIKI_DIR'
    | 'cwd'
    | 'app-state'
    | 'local-knowledge'
    | 'none'
}

const LOCAL_KNOWLEDGE_DIR_NAMES = ['风机故障码']
const LOCAL_KNOWLEDGE_FILE_LIMIT = 120

export const LLMWIKI_APP_STATE_PATH = join(
  homedir(),
  'Library',
  'Application Support',
  'com.llmwiki.app',
  'app-state.json',
)

export async function selectLLMWikiProject(
  explicitProjectPath?: string,
): Promise<LLMWikiProject | null> {
  return (await resolveLLMWikiProject(explicitProjectPath)).project
}

export async function resolveLLMWikiProject(
  explicitProjectPath?: string,
): Promise<LLMWikiProjectResolution> {
  if (explicitProjectPath) {
    return {
      project: await projectFromConfiguredPath(explicitProjectPath, 'explicit'),
      source: 'explicit',
    }
  }

  if (process.env.LLMWIKI_PROJECT) {
    return {
      project: await projectFromConfiguredPath(
        process.env.LLMWIKI_PROJECT,
        'LLMWIKI_PROJECT',
      ),
      source: 'LLMWIKI_PROJECT',
    }
  }

  if (process.env.LLMWIKI_DIR) {
    return {
      project: await projectFromConfiguredPath(
        process.env.LLMWIKI_DIR,
        'LLMWIKI_DIR',
      ),
      source: 'LLMWIKI_DIR',
    }
  }

  const cwdProject = await findLLMWikiProjectFromCwd()
  if (cwdProject) {
    return { project: cwdProject, source: 'cwd' }
  }

  const projects = await loadLLMWikiProjectsFromAppState()
  if (projects[0]) {
    return { project: projects[0], source: 'app-state' }
  }

  const localKnowledgeProject = await findLocalKnowledgeProjectFromCwd()
  if (localKnowledgeProject) {
    return { project: localKnowledgeProject, source: 'local-knowledge' }
  }

  return { project: null, source: 'none' }
}

export async function findLLMWikiProjectFromCwd(
  startDir = getCwd(),
): Promise<LLMWikiProject | null> {
  let dir = resolve(startDir)
  while (true) {
    if (await isLLMWikiProject(dir)) {
      return { name: basename(dir), path: dir }
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export async function loadLLMWikiProjectsFromAppState(): Promise<
  LLMWikiProject[]
> {
  let raw: string
  try {
    raw = await readFile(LLMWIKI_APP_STATE_PATH, 'utf8')
  } catch {
    return []
  }

  const state = JSON.parse(raw) as AppState
  const byPath = new Map<string, LLMWikiProject>()

  for (const project of [
    state.lastProject,
    ...(state.recentProjects ?? []),
    ...Object.values(state.projectRegistry ?? {}),
  ]) {
    if (project?.path) {
      byPath.set(project.path, {
        ...project,
        name: project.name || basename(project.path),
      })
    }
  }

  const existing: LLMWikiProject[] = []
  for (const project of byPath.values()) {
    if (await isLLMWikiProject(project.path)) {
      existing.push(project)
    }
  }

  return existing.sort((a, b) => (b.lastOpened ?? 0) - (a.lastOpened ?? 0))
}

export async function isLLMWikiProject(projectPath: string): Promise<boolean> {
  try {
    const info = await stat(join(projectPath, '.llm-wiki'))
    return info.isDirectory()
  } catch {
    return false
  }
}

export async function isLocalKnowledgeProject(
  projectPath: string,
): Promise<boolean> {
  try {
    const info = await stat(projectPath)
    if (!info.isDirectory()) return false
  } catch {
    return false
  }

  return hasTextLikeFiles(projectPath, LOCAL_KNOWLEDGE_FILE_LIMIT)
}

export function isConfiguredLLMWikiPathPresent(pathValue: string): boolean {
  return existsSync(resolve(pathValue))
}

async function projectFromConfiguredPath(
  configuredPath: string,
  label: 'explicit' | 'LLMWIKI_PROJECT' | 'LLMWIKI_DIR',
): Promise<LLMWikiProject> {
  const projectPath = normalizeConfiguredProjectPath(configuredPath)
  if (await isLLMWikiProject(projectPath)) {
    return { name: basename(projectPath), path: projectPath }
  }
  if (label !== 'LLMWIKI_DIR' && (await isLocalKnowledgeProject(projectPath))) {
    return { name: basename(projectPath), path: projectPath }
  }
  throw new Error(
    `${label} points to ${resolve(configuredPath)}, but ${projectPath} is not an LLMWiki project or local text knowledge directory`,
  )
}

function normalizeConfiguredProjectPath(configuredPath: string): string {
  const absolutePath = resolve(configuredPath)
  return basename(absolutePath) === '.llm-wiki'
    ? dirname(absolutePath)
    : absolutePath
}

async function findLocalKnowledgeProjectFromCwd(
  startDir = getCwd(),
): Promise<LLMWikiProject | null> {
  let dir = resolve(startDir)
  while (true) {
    for (const name of LOCAL_KNOWLEDGE_DIR_NAMES) {
      const candidate = join(dir, name)
      if (await isLocalKnowledgeProject(candidate)) {
        return { name, path: candidate }
      }
    }

    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

async function hasTextLikeFiles(dirPath: string, limit: number): Promise<boolean> {
  if (limit <= 0) return false

  let entries = []
  try {
    entries = await readdir(dirPath, { withFileTypes: true })
  } catch {
    return false
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const childPath = join(dirPath, entry.name)
    if (entry.isFile() && isTextLike(childPath)) return true
    if (entry.isDirectory()) {
      if (await hasTextLikeFiles(childPath, limit - 1)) return true
    }
  }

  return false
}

function isTextLike(filePath: string): boolean {
  return /\.(md|mdx|txt|csv|json|html?|rtf)$/i.test(filePath)
}
