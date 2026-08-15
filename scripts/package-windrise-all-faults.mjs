#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OUT_DIR = join(ROOT, 'offline-dist')
const BASE_GLOB_PREFIX = 'windrise-ubuntu-offline-'

const args = parseArgs(process.argv.slice(2))
const stamp = timestamp()
const buildRoot = resolve(args.buildRoot ?? `/tmp/windrise-all-faults-build-${stamp}`)
const outDir = resolve(args.outDir ?? OUT_DIR)
const baseBundle = resolve(args.baseBundle ?? await findNewestBaseBundle(outDir))
const extractDir = join(buildRoot, 'extract')
const projectRoot = join(extractDir, 'windrise')
const bundleName = `windrise-ubuntu-all-faults-${stamp}.tar.gz`
const bundlePath = join(outDir, bundleName)
const deliveryDir = join(outDir, `windrise-ubuntu-all-faults-delivery-${stamp}`)
const fflateModulePath = await requireResolve('fflate')
const buildEnv = {
  ...process.env,
  FFLATE_MODULE_PATH: fflateModulePath,
}

await main()

async function main() {
  console.log(`Base bundle: ${baseBundle}`)
  console.log(`Build root: ${buildRoot}`)

  await rm(buildRoot, { recursive: true, force: true })
  await mkdir(extractDir, { recursive: true })
  await mkdir(outDir, { recursive: true })

  console.log('[1/6] Extracting base Ubuntu offline runtime')
  await execFileAsync('tar', ['-xzf', baseBundle, '-C', extractDir], {
    maxBuffer: 1024 * 1024 * 64,
  })

  console.log('[2/6] Replacing packaged project with current workspace')
  await rm(projectRoot, { recursive: true, force: true })
  await mkdir(projectRoot, { recursive: true })
  await execFileAsync(
    'rsync',
    [
      '-a',
      '--delete',
      '--exclude',
      '.git',
      '--exclude',
      '.DS_Store',
      '--exclude',
      'node_modules',
      '--exclude',
      'offline-dist',
      '--exclude',
      'hn/.venv',
      '--exclude',
      'hn/logs',
      '--exclude',
      'hn/.env',
      '--exclude',
      'hn/dify_webserver_project_py313_minimal/.env',
      '--exclude',
      '__pycache__',
      '--exclude',
      'hn/__pycache__',
      '--exclude',
      'hn/dify_webserver_project_py313_minimal/__pycache__',
      '--exclude',
      'hn/dify_webserver_project_py313_minimal/offline_install',
      '--exclude',
      'hn/chat_users.db',
      '--exclude',
      'hn/dify_webserver_project_py313_minimal/chat_users.db',
      '--exclude',
      'hn/bootstrap_admin_credentials.txt',
      '--exclude',
      'hn/flask_secret_key',
      '--exclude',
      'hn/dify_webserver_project_py313_minimal/flask_secret_key',
      '--exclude',
      'hn/dify_webserver_project_py313_minimal.tar.gz',
      '--exclude',
      '*.pyc',
      `${ROOT}/`,
      `${projectRoot}/`,
    ],
    { maxBuffer: 1024 * 1024 * 64 },
  )

  console.log('[3/6] Rebuilding full fault indexes')
  await execFileAsync(process.execPath, [join(projectRoot, 'scripts', 'build-fault-index.mjs')], {
    cwd: projectRoot,
    env: buildEnv,
    maxBuffer: 1024 * 1024 * 64,
  })
  await execFileAsync(process.execPath, [join(projectRoot, 'scripts', 'build-wind-llmwiki.mjs')], {
    cwd: projectRoot,
    env: buildEnv,
    maxBuffer: 1024 * 1024 * 64,
  })

  console.log('[4/6] Fixing executable bits and writing package notes')
  await execFileAsync('cp', [
    join(projectRoot, 'deploy', 'ubuntu-offline', 'run-web.sh'),
    join(extractDir, 'run-web.sh'),
  ])
  await execFileAsync('cp', [
    join(projectRoot, 'deploy', 'ubuntu-offline', 'install_offline.sh'),
    join(extractDir, 'install_offline.sh'),
  ])
  await execFileAsync('cp', [
    join(projectRoot, 'deploy', 'ubuntu-offline', 'windrise-bash'),
    join(projectRoot, 'bin', 'windrise-bash'),
  ])
  await chmod(join(extractDir, 'run-web.sh'), 0o755)
  await chmod(join(extractDir, 'install_offline.sh'), 0o755)
  await chmod(join(projectRoot, 'bin', 'windrise'), 0o755)
  await chmod(join(projectRoot, 'bin', 'windrise-bash'), 0o755)
  const summary = JSON.parse(await readFile(join(projectRoot, '风机故障码', 'fault-index-summary.json'), 'utf8'))
  await writeFile(join(extractDir, 'README_ALL_FAULTS.md'), packageReadme(bundleName, summary), 'utf8')
  await writeFile(join(projectRoot, 'README_ALL_FAULTS.md'), packageReadme('本包内文件', summary), 'utf8')

  console.log('[5/6] Writing all-faults Ubuntu offline bundle')
  await execFileAsync('tar', ['-czf', bundlePath, '-C', extractDir, '.'], {
    maxBuffer: 1024 * 1024 * 64,
  })

  console.log('[6/6] Writing delivery directory and checksums')
  await rm(deliveryDir, { recursive: true, force: true })
  await mkdir(deliveryDir, { recursive: true })
  await execFileAsync('cp', [bundlePath, join(deliveryDir, bundleName)])
  const sha256 = await fileSha256(bundlePath)
  await writeFile(join(deliveryDir, 'SHA256SUMS.txt'), `${sha256}  ${bundleName}\n`, 'utf8')
  await writeFile(join(deliveryDir, 'README_ALL_FAULTS.md'), packageReadme(bundleName, summary), 'utf8')

  console.log(JSON.stringify({
    bundle: bundlePath,
    delivery: deliveryDir,
    sha256,
    totalRecords: summary.recordCount,
    byBrand: summary.byBrand,
    byModel: summary.byModel,
  }, null, 2))
}

async function findNewestBaseBundle(outDir) {
  const entries = await readdir(outDir).catch(() => [])
  const candidates = []
  for (const entry of entries) {
    if (!entry.startsWith(BASE_GLOB_PREFIX) || !entry.endsWith('.tar.gz')) continue
    const full = join(outDir, entry)
    const info = await stat(full)
    candidates.push({ path: full, mtime: info.mtimeMs })
  }
  candidates.sort((a, b) => b.mtime - a.mtime)
  if (!candidates[0]) {
    throw new Error(`No base Ubuntu offline bundle found in ${outDir}`)
  }
  return candidates[0].path
}

async function fileSha256(filePath) {
  const hash = createHash('sha256')
  hash.update(await readFile(filePath))
  return hash.digest('hex')
}

function packageReadme(bundleName, summary) {
  return [
    '# Windrise Ubuntu 全量故障码离线运行包',
    '',
    `包文件：${bundleName}`,
    '',
    '内容：',
    '- 包含当前工作区的完整登录系统更新。',
    '- 包含 `风机故障码/` 下全部故障码资料。',
    '- `wind-llmwiki/` 已按全量故障码索引重新生成。',
    '- 默认连接 vLLM OpenAI 兼容接口：`VLLM_API_URL=http://10.46.161.210:9527/v1/chat/completions`。',
    '- 默认模型名：`VLLM_MODEL_NAME=Qwen-30B`。',
    '- 不包含运行时数据库、初始凭据文件、Dify key、本机 `.env` 或 Flask 会话密钥文件。',
    '',
    `全量故障记录：${summary.recordCount ?? '未知'}`,
    '',
    '离线 Ubuntu 上使用方式与普通 Windrise 离线包相同。',
    '',
  ].join('\n')
}

function timestamp() {
  const date = new Date()
  const pad = value => String(value).padStart(2, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '_',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('')
}

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index++) {
    const item = argv[index]
    if (item === '--base-bundle') parsed.baseBundle = argv[++index]
    else if (item.startsWith('--base-bundle=')) parsed.baseBundle = item.slice('--base-bundle='.length)
    else if (item === '--out-dir') parsed.outDir = argv[++index]
    else if (item.startsWith('--out-dir=')) parsed.outDir = item.slice('--out-dir='.length)
    else if (item === '--build-root') parsed.buildRoot = argv[++index]
    else if (item.startsWith('--build-root=')) parsed.buildRoot = item.slice('--build-root='.length)
    else if (item === '--help' || item === '-h') {
      console.log(`Usage: node ${relative(ROOT, fileURLToPath(import.meta.url))} [--base-bundle <tar.gz>] [--out-dir <dir>] [--build-root <dir>]`)
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${item}`)
    }
  }
  return parsed
}

function requireResolve(packageName) {
  return execFileAsync(process.execPath, ['-e', `console.log(require.resolve(${JSON.stringify(packageName)}))`], {
    cwd: ROOT,
  }).then(result => result.stdout.trim())
}
