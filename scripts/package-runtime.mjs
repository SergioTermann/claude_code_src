#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { chmod, cp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { basename, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const outRoot = join(root, 'runtime-dist')
const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, '')
  .replace(/\..+$/, '')
const packageName = `windrise-runtime-${process.platform}-${process.arch}-${stamp}`
const outDir = join(outRoot, packageName)

const runtimeEntries = [
  'package.json',
  'package-lock.json',
  'dist',
  'node_modules',
  'src',
  'scripts',
  'bin',
  'types',
  'vendor',
  'assets',
  '风机故障码',
  'wind-llmwiki',
]

await execFileAsync(process.execPath, [join(root, 'scripts', 'build.mjs')], {
  cwd: root,
  stdio: 'inherit',
})

await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

for (const entry of runtimeEntries) {
  const source = join(root, entry)
  if (!existsSync(source)) continue
  const info = await stat(source)
  await cp(source, join(outDir, entry), {
    recursive: info.isDirectory(),
    verbatimSymlinks: true,
  })
}

await mkdir(join(outDir, 'node', 'bin'), { recursive: true })
await cp(process.execPath, join(outDir, 'node', 'bin', 'node'))
await chmod(join(outDir, 'node', 'bin', 'node'), 0o755)
await copyNodeRuntimeLibraries(outDir)

await writeFile(join(outDir, 'windrise'), launcher(), 'utf8')
await chmod(join(outDir, 'windrise'), 0o755)
await writeFile(join(outDir, 'README_RUNTIME.md'), readme(packageName), 'utf8')

const tarball = `${outDir}.tar.gz`
await rm(tarball, { force: true })
await execFileAsync('tar', ['-czf', tarball, '-C', outRoot, packageName], {
  maxBuffer: 30 * 1024 * 1024,
})

console.log(`Runtime package directory: ${outDir}`)
console.log(`Runtime package tarball: ${tarball}`)

function launcher() {
  return `#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
NODE="$ROOT/node/bin/node"
if [[ -x "$NODE" ]]; then
  if ! "$NODE" --version >/dev/null 2>&1; then
    NODE=""
  fi
else
  NODE=""
fi
if [[ -z "$NODE" ]]; then
  NODE="$(command -v node)"
fi
if [[ -z "$NODE" ]]; then
  echo "ERROR: node is required but was not found." >&2
  exit 1
fi

export PATH="$ROOT/node/bin:$PATH"
export ANTHROPIC_MODEL_PROVIDER="\${ANTHROPIC_MODEL_PROVIDER:-lmstudio}"
export WINDRISE_MODEL_MODE="\${WINDRISE_MODEL_MODE:-lmstudio}"
export LMSTUDIO_BASE_URL="\${LMSTUDIO_BASE_URL:-http://127.0.0.1:1234}"
export LMSTUDIO_MODEL="\${LMSTUDIO_MODEL:-qwen/qwen3.5-9b}"
export LMSTUDIO_CHAT_MODEL="\${LMSTUDIO_CHAT_MODEL:-$LMSTUDIO_MODEL}"
export DISABLE_INSTALLATION_CHECKS="\${DISABLE_INSTALLATION_CHECKS:-1}"
export MAX_THINKING_TOKENS="\${MAX_THINKING_TOKENS:-0}"
export WINDRISE_ENABLE_THINKING="\${WINDRISE_ENABLE_THINKING:-0}"
export WINDRISE=1

case "\${1:-}" in
  ""|chat)
    [[ "\${1:-}" == "chat" ]] && shift
    exec "$NODE" "$ROOT/scripts/run-lmstudio-claude.mjs" "$@"
    ;;
  ask)
    shift
    exec "$NODE" "$ROOT/scripts/windrise-chat.mjs" "$@"
    ;;
  doctor)
    exec "$NODE" "$ROOT/scripts/run-lmstudio-claude.mjs" --print --bare /lmstudio
    ;;
  skills)
    exec "$NODE" "$ROOT/scripts/run-lmstudio-claude.mjs" --print --bare "/lmstudio skills"
    ;;
  search)
    shift
    exec "$NODE" "$ROOT/scripts/run-lmstudio-claude.mjs" --print --bare "/llmwiki ask $* --limit 8"
    ;;
  help|-h|--help)
    cat <<'EOF'
Windrise runtime usage:
  ./windrise                         start interactive UI
  ./windrise ask                     start simple chat mode
  ./windrise "303804是什么故障"       ask once
  ./windrise search 主断路器跳开      search local knowledge
  ./windrise doctor                  check local model and knowledge setup
  ./windrise skills                  list local skills

Environment:
  LMSTUDIO_BASE_URL=http://127.0.0.1:1234
  LMSTUDIO_MODEL=qwen/qwen3.5-9b
  WINDRISE_MODEL_MODE=lmstudio
EOF
    ;;
  *)
    printf '%s\\nexit\\n' "$*" | "$NODE" "$ROOT/scripts/windrise-chat.mjs"
    ;;
esac
`
}

function readme(name) {
  return `# Windrise Runtime Package

This is a runnable package built from ${relative(root, outDir)}.

## Run

\`\`\`bash
tar -xzf ${name}.tar.gz
cd ${name}
./windrise doctor
./windrise "主断路器异常跳开是什么故障造成的"
\`\`\`

The launcher first tries the bundled Node.js executable. If that executable is
not usable on the target machine, it automatically falls back to \`node\` from
\`PATH\`.

Bundled Node source path:

\`\`\`text
${process.execPath}
\`\`\`

Default local model endpoint:

\`\`\`bash
LMSTUDIO_BASE_URL=http://127.0.0.1:1234
LMSTUDIO_MODEL=qwen/qwen3.5-9b
\`\`\`

For vLLM:

\`\`\`bash
WINDRISE_MODEL_MODE=vllm LMSTUDIO_BASE_URL=http://10.46.161.210:9527 LMSTUDIO_MODEL=Qwen-30B ./windrise
\`\`\`
`
}

async function copyNodeRuntimeLibraries(targetRoot) {
  if (process.platform !== 'darwin') return

  const nodeDir = resolve(process.execPath, '..')
  const libDir = resolve(nodeDir, '..', 'lib')
  const targetLibDir = join(targetRoot, 'node', 'lib')
  if (!existsSync(libDir)) return

  await mkdir(targetLibDir, { recursive: true })
  const { stdout } = await execFileAsync('find', [libDir, '-maxdepth', '1', '-name', 'libnode*.dylib', '-print'])
  for (const file of stdout.split('\n').filter(Boolean)) {
    await cp(file, join(targetLibDir, basename(file)))
  }
}
