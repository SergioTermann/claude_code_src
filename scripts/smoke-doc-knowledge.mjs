#!/usr/bin/env node

import { execFile } from 'child_process'
import { mkdtemp, readFile, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const temp = await mkdtemp(join(tmpdir(), 'doc-knowledge-'))
const input = join(temp, 'test-fault.md')
const out = join(temp, 'out')
const project = join(out, 'test-fault-llmwiki')

await writeFile(
  input,
  [
    '# 测试故障手册',
    '',
    '风场：测试风场，品牌：测试品牌，机型：TEST-1500。',
    '',
    '故障代码：990001',
    '故障名称：测试变桨通信故障',
    '故障原因：通信线缆松动或 PLC 模块异常。',
    '故障处理：检查通信线缆；检查 PLC 模块；复位后观察。',
  ].join('\n'),
  'utf8',
)

await step('build document knowledge project', async () => {
  await execFileAsync('node', [join(root, 'scripts', 'build-doc-knowledge.mjs'), input, '--out', out], {
    cwd: root,
    maxBuffer: 1024 * 1024 * 8,
  })
})

await step('generated files exist', async () => {
  for (const rel of [
    '.llm-wiki/file-snapshot.json',
    'wiki/index.md',
    'graph/knowledge-graph.json',
    'graph/visualization.html',
    'fault-index.jsonl',
  ]) {
    const info = await stat(join(project, rel))
    if (!info.isFile()) throw new Error(`${rel} is not a file`)
  }
})

await step('fault index contains structured code', async () => {
  const text = await readFile(join(project, 'fault-index.jsonl'), 'utf8')
  assertIncludes(text, '990001')
  assertIncludes(text, '测试变桨通信故障')
})

await step('llmwiki can search generated fault code', async () => {
  const { stdout } = await execFileAsync(
    'node',
    [
      join(root, 'scripts', 'run-lmstudio-claude.mjs'),
      '--print',
      '--bare',
      '--max-turns',
      '1',
      '/llmwiki search 990001 --limit 2',
    ],
    {
      cwd: root,
      env: { ...process.env, LLMWIKI_PROJECT: project },
      maxBuffer: 1024 * 1024 * 8,
    },
  )
  assertIncludes(stdout, '990001')
  assertIncludes(stdout, '测试变桨通信故障')
})

console.log('doc-knowledge smoke checks passed')

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
