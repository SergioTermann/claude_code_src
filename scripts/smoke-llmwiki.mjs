#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const runner = join(root, 'scripts', 'run-lmstudio-claude.mjs')
const windriseBin = join(root, 'bin', 'windrise')
const localKnowledgeProject = join(root, '风机故障码')

await step('default local knowledge project is discovered', async () => {
  const { stdout } = await runRunner(['/llmwiki path'])
  assertIncludes(stdout, '风机故障码')
  assertIncludes(stdout, localKnowledgeProject)
})

await step('local knowledge search returns evidence', async () => {
  const { stdout } = await runRunner(['/llmwiki search 风速仪 --limit 1'])
  assertIncludes(stdout, 'Matches for "风速仪"')
  assertIncludes(stdout, '风速仪')
})

await step('descriptive search reranks complete local matches first', async () => {
  const { stdout } = await runRunner(['/llmwiki search 变桨24V开关 --limit 1'])
  assertIncludes(stdout, '303804')
  assertIncludes(stdout, '24V主电源开关故障')
})

await step('/llmwiki ask returns structured local answer', async () => {
  const { stdout } = await runRunner(['/llmwiki ask 303804 --limit 2'])
  assertIncludes(stdout, '本地答案：303804')
  assertIncludes(stdout, '24V主电源开关故障')
  assertIncludes(stdout, '来源：')
})

await step('long numeric fault code is not split into shorter codes', async () => {
  const { stdout } = await runRunner(['/llmwiki ask 故障码1100007 --limit 2'])
  assertIncludes(stdout, '1100007')
  assertIncludes(stdout, '机舱合成振动超过限值')
  assertNotIncludes(stdout, '变频器故障码：7')
  assertNotIncludes(stdout, '更换GSC')
})

await step('explicit LLMWIKI_PROJECT can be a text corpus', async () => {
  const { stdout } = await runRunner(['/llmwiki search 风速仪 --limit 1'], {
    ...process.env,
    LLMWIKI_PROJECT: localKnowledgeProject,
  })
  assertIncludes(stdout, 'Matches for "风速仪"')
})

await step('windrise bin uses repository-relative paths', async () => {
  const { stdout } = await runBin(['tree'])
  assertIncludes(stdout, 'HW2S2000')
})

await step('windrise bin preserves launch directory for local knowledge', async () => {
  const tempProject = await mkdtemp(join(tmpdir(), 'windrise-cwd-'))
  await writeFile(join(tempProject, '.llm-wiki'), '')
  await writeFile(
    join(tempProject, 'cwd-check.md'),
    'UNIQUE_WINDRISE_CWD_MARKER\n',
  )
  const { stdout } = await runBin(['search', 'UNIQUE_WINDRISE_CWD_MARKER'], {
    cwd: tempProject,
  })
  assertIncludes(stdout, 'UNIQUE_WINDRISE_CWD_MARKER')
  assertIncludes(stdout, basename(tempProject))
})

await step('windrise bin search uses local knowledge', async () => {
  const { stdout } = await runBin(['search', '风速仪'])
  assertIncludes(stdout, 'Matches for "风速仪"')
})

await step('windrise bin answers built-in wind farm model mapping by site', async () => {
  const { stdout } = await runBin(['查询新华风电场对应什么风机'], {
    LMSTUDIO_BASE_URL: 'http://127.0.0.1:9',
  })
  assertIncludes(stdout, '新华风电场')
  assertIncludes(stdout, '三一 SE8715')
  assertIncludes(stdout, '华仪 HW2/S1500(87)')
  assertIncludes(stdout, '运达 WD88-1500A')
  assertNotIncludes(stdout, '联网搜索')
})

await step('windrise bin answers built-in wind farm model mapping by model', async () => {
  const { stdout } = await runBin(['WD147-3000是哪个风场的机型'], {
    LMSTUDIO_BASE_URL: 'http://127.0.0.1:9',
  })
  assertIncludes(stdout, '（四期）/（五期）吉林通榆团结D风电场')
  assertIncludes(stdout, '运达 WD147-3000')
})

await step('windrise bin numeric one-shot triggers retrieval', async () => {
  const { stdout } = await runBin(['303804'], {
    LMSTUDIO_BASE_URL: 'http://127.0.0.1:9',
  })
  assertIncludes(stdout, '正在检索「303804」')
  assertIncludes(stdout, '本地答案：303804')
  assertIncludes(stdout, '24V主电源开关故障')
})

await step('windrise bin natural fault question triggers retrieval', async () => {
  const { stdout } = await runBin(['303804是什么故障，怎么处理'], {
    LMSTUDIO_BASE_URL: 'http://127.0.0.1:9',
  })
  assertIncludes(stdout, '正在检索「303804」')
  assertIncludes(stdout, '本地答案：303804')
  assertIncludes(stdout, '24V主电源开关故障')
})

await step('windrise bin preserves long numeric fault code', async () => {
  const { stdout } = await runBin(['故障码1100007'], {
    LMSTUDIO_BASE_URL: 'http://127.0.0.1:9',
  })
  assertIncludes(stdout, '正在检索「1100007」')
  assertIncludes(stdout, '本地答案：1100007')
  assertIncludes(stdout, '机舱合成振动超过限值')
  assertNotIncludes(stdout, '更换GSC')
})

console.log('\nLLMWiki smoke passed.')

async function step(name, fn) {
  process.stdout.write(`- ${name}... `)
  await fn()
  process.stdout.write('OK\n')
}

async function runRunner(args, env = process.env) {
  try {
    const result = await execFileAsync(
      process.execPath,
      [runner, '--print', '--bare', ...args],
      {
        cwd: root,
        env: {
          ...env,
          ANTHROPIC_MODEL_PROVIDER:
            env.ANTHROPIC_MODEL_PROVIDER || 'lmstudio',
          LMSTUDIO_BASE_URL: env.LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234',
          LMSTUDIO_MODEL: env.LMSTUDIO_MODEL || 'qwen3.5-9b-coder',
        },
        maxBuffer: 20 * 1024 * 1024,
        timeout: 120_000,
      },
    )
    return result
  } catch (error) {
    throw new Error(`${error.stdout ?? ''}${error.stderr ?? ''}` || error.message)
  }
}

async function runBin(args, options = {}) {
  const { cwd = root, ...env } = options
  try {
    return await execFileAsync(windriseBin, args, {
      cwd,
      env: {
        ...process.env,
        ...env,
        ANTHROPIC_MODEL_PROVIDER:
          env.ANTHROPIC_MODEL_PROVIDER ||
          process.env.ANTHROPIC_MODEL_PROVIDER ||
          'lmstudio',
        LMSTUDIO_BASE_URL:
          env.LMSTUDIO_BASE_URL ||
          process.env.LMSTUDIO_BASE_URL ||
          'http://127.0.0.1:1234',
        LMSTUDIO_MODEL: env.LMSTUDIO_MODEL || process.env.LMSTUDIO_MODEL || 'qwen3.5-9b-coder',
      },
      maxBuffer: 20 * 1024 * 1024,
      timeout: 120_000,
    })
  } catch (error) {
    throw new Error(`${error.stdout ?? ''}${error.stderr ?? ''}` || error.message)
  }
}

function assertIncludes(value, expected) {
  if (!value.includes(expected)) {
    throw new Error(`Expected output to include ${JSON.stringify(expected)}:\n${value}`)
  }
}

function assertNotIncludes(value, unexpected) {
  if (value.includes(unexpected)) {
    throw new Error(`Expected output not to include ${JSON.stringify(unexpected)}:\n${value}`)
  }
}
