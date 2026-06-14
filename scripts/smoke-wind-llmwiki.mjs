#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const project = join(root, 'wind-llmwiki')
const runner = join(root, 'scripts', 'run-lmstudio-claude.mjs')

await step('wind-llmwiki project files exist', async () => {
  for (const rel of [
    '.llm-wiki/file-snapshot.json',
    'wiki/index.md',
    'wiki/knowledge-graph.md',
    'graph/knowledge-graph.json',
    'graph/triples.jsonl',
    'graph/nodes.csv',
    'graph/edges.csv',
    'graph/visualization.html',
    'fault-index.jsonl',
    'wiki/quality-report.md',
  ]) {
    const info = await stat(join(project, rel))
    if (!info.isFile()) throw new Error(`${rel} is not a file`)
  }
})

await step('knowledge graph has expected scale and schema', async () => {
  const graph = JSON.parse(
    await readFile(join(project, 'graph', 'knowledge-graph.json'), 'utf8'),
  )
  assertAtLeast(graph.nodes.length, 20000, 'node count')
  assertAtLeast(graph.edges.length, 50000, 'edge count')
  assertIncludes(Object.keys(graph.indexes.countsByNodeType).join(','), 'site')
  assertIncludes(Object.keys(graph.indexes.countsByNodeType).join(','), 'model')
  assertIncludes(Object.keys(graph.indexes.countsByEdgeType).join(','), 'USES_MODEL')
  assertIncludes(Object.keys(graph.indexes.countsByEdgeType).join(','), 'OCCURS_ON_MODEL')
  assertIncludes(Object.keys(graph.indexes.countsByNodeType).join(','), 'component')
  assertIncludes(Object.keys(graph.indexes.countsByNodeType).join(','), 'reset_mode')
  assertIncludes(Object.keys(graph.indexes.countsByEdgeType).join(','), 'INVOLVES_COMPONENT')
  assertIncludes(Object.keys(graph.indexes.countsByEdgeType).join(','), 'HAS_RESET_MODE')
  assertAtLeast(graph.indexes.quality.classifiedFaultCount, 4000, 'classified fault count')
  assertAtLeast(graph.indexes.quality.faultsWithComponents, 3000, 'component coverage')
  assertAtLeast(graph.indexes.quality.faultsWithResetMode, 2500, 'reset mode coverage')
  assertIncludes(
    graph.indexes.topComponents.map(item => item.label).join(','),
    'PLC控制器',
  )
})

await step('llmwiki resolves the generated project', async () => {
  const { stdout } = await runLlmwiki('/llmwiki path')
  assertIncludes(stdout, 'wind-llmwiki')
  assertIncludes(stdout, project)
})

await step('wind farm model knowledge is searchable', async () => {
  const { stdout } = await runLlmwiki('/llmwiki search 新华 SE8715 --limit 3')
  assertIncludes(stdout, '新华')
  assertIncludes(stdout, '三一 SE8715')
})

await step('fault code knowledge is searchable from copied fault index', async () => {
  const { stdout } = await runLlmwiki('/llmwiki search 1100007 --limit 3')
  assertIncludes(stdout, '1100007')
  assertIncludes(stdout, '机舱合成振动超过限值')
  assertNotIncludes(stdout, '更换 GSC')
})

await step('knowledge graph guide is readable', async () => {
  const { stdout } = await runLlmwiki('/llmwiki read wiki/knowledge-graph.md')
  assertIncludes(stdout, '知识图谱说明')
  assertIncludes(stdout, 'USES_MODEL')
  assertIncludes(stdout, 'OCCURS_ON_MODEL')
})

await step('knowledge graph quality report is readable', async () => {
  const { stdout } = await runLlmwiki('/llmwiki read wiki/quality-report.md')
  assertIncludes(stdout, '图谱质量报告')
  assertIncludes(stdout, '包含部件关系')
  assertIncludes(stdout, '包含复位方式')
})

console.log('wind-llmwiki smoke checks passed')

async function runLlmwiki(command) {
  return execFileAsync(
    'node',
    [runner, '--print', '--bare', '--max-turns', '1', command],
    {
      cwd: root,
      env: {
        ...process.env,
        LLMWIKI_PROJECT: project,
      },
      maxBuffer: 1024 * 1024 * 16,
    },
  )
}

async function step(name, fn) {
  process.stdout.write(`- ${name}... `)
  try {
    await fn()
    console.log('ok')
  } catch (error) {
    console.log('failed')
    throw error
  }
}

function assertIncludes(value, expected) {
  if (!value.includes(expected)) {
    throw new Error(`Expected output to include ${JSON.stringify(expected)}:\n${value}`)
  }
}

function assertNotIncludes(value, expected) {
  if (value.includes(expected)) {
    throw new Error(`Expected output not to include ${JSON.stringify(expected)}:\n${value}`)
  }
}

function assertAtLeast(value, minimum, label) {
  if (value < minimum) {
    throw new Error(`Expected ${label} >= ${minimum}, got ${value}`)
  }
}
