#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { cp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '_')
const defaultOut = join(root, 'offline-dist', `windrise-ubuntu-simple-web-${stamp}`)
const outDir = resolve(process.argv[2] || defaultOut)

const entries = [
  'package.json',
  'package-lock.json',
  '.env',
  'README.md',
  'simple_home.html',
  'logo.png',
  '主页.png',
  'run-ubuntu-simple-web.sh',
  'dist',
  'scripts',
  'bin',
  'types',
  'vendor',
  'assets',
  'wind-llmwiki',
  '风机故障码',
  'generated-knowledge',
  '偏航液压系统压力异常故障处理问题串汇总.md',
  '偏航液压系统压力异常故障处理问题串汇总.pdf',
]

if (existsSync(outDir)) {
  throw new Error(`Output directory already exists: ${outDir}`)
}

await mkdir(outDir, { recursive: true })

const copied = []
for (const entry of entries) {
  const source = join(root, entry)
  if (!existsSync(source)) continue
  const info = await stat(source)
  await cp(source, join(outDir, entry), {
    recursive: info.isDirectory(),
    verbatimSymlinks: false,
  })
  copied.push(entry)
}

await installLinuxNodeModules(outDir)
copied.push('node_modules (linux-x64)')

await mkdir(join(outDir, 'bin'), { recursive: true })
await writeFile(join(outDir, 'bin', 'windrise-bash'), windriseBashEntry(), 'utf8')

await writeFile(join(outDir, 'README_Ubuntu_Simple_Web.md'), ubuntuReadme(), 'utf8')
await writeFile(
  join(outDir, 'UBUNTU_SIMPLE_WEB_MANIFEST.json'),
  `${JSON.stringify({ createdAt: new Date().toISOString(), sourceRoot: root, packageRoot: outDir, copied }, null, 2)}\n`,
  'utf8',
)

await chmodBestEffort([
  join(outDir, 'run-ubuntu-simple-web.sh'),
  join(outDir, 'bin', 'windrise'),
  join(outDir, 'bin', 'windrise-bash'),
])

const tarball = `${outDir}.tar.gz`
await execFileAsync('tar', ['-czf', tarball, '-C', resolve(outDir, '..'), basename(outDir)], {
  maxBuffer: 20 * 1024 * 1024,
})

console.log(`Ubuntu Simple Web package written to ${outDir}`)
console.log(`Ubuntu Simple Web tarball written to ${tarball}`)
console.log(`Run on Ubuntu: tar -xzf ${basename(tarball)} && cd ${basename(outDir)} && ./run-ubuntu-simple-web.sh`)

async function installLinuxNodeModules(packageDir) {
  console.log('Installing Ubuntu x64 Node.js dependencies into package...')
  await rm(join(packageDir, 'node_modules'), { recursive: true, force: true })
  await execFileAsync(
    'npm',
    [
      'ci',
      '--ignore-scripts',
      '--include=dev',
      '--include=optional',
      '--os=linux',
      '--cpu=x64',
      '--libc=glibc',
    ],
    {
      cwd: packageDir,
      env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' },
      maxBuffer: 30 * 1024 * 1024,
    },
  )
  await assertLinuxDependency(packageDir, 'node_modules/@esbuild/linux-x64')
  await assertLinuxDependency(packageDir, 'node_modules/@img/sharp-linux-x64')
  await assertLinuxDependency(packageDir, 'node_modules/@img/sharp-libvips-linux-x64')
}

async function assertLinuxDependency(packageDir, relPath) {
  if (!existsSync(join(packageDir, relPath))) {
    throw new Error(`Ubuntu dependency missing after npm ci: ${relPath}`)
  }
}

async function chmodBestEffort(paths) {
  for (const filePath of paths) {
    if (!existsSync(filePath)) continue
    try {
      await execFileAsync('chmod', ['+x', filePath])
    } catch {}
  }
}

function ubuntuReadme() {
  return `# Windrise Ubuntu Simple Web 部署包

## 运行方式

在 Ubuntu 上执行：

\`\`\`bash
tar -xzf windrise-ubuntu-simple-web-*.tar.gz
cd windrise-ubuntu-simple-web-*
./run-ubuntu-simple-web.sh
\`\`\`

浏览器访问：

\`\`\`
http://127.0.0.1:5001/
\`\`\`

管理员提示页：

\`\`\`
http://127.0.0.1:5001/admin
\`\`\`

## 前提

- Ubuntu x86_64
- Node.js 22 LTS 或更高版本，包含 npm
- 已配置 SiliconFlow API Key，或其他 OpenAI Compatible 模型服务

部署包已预装 Ubuntu x64 的 Node.js 依赖，包括 esbuild、sharp 和 libvips。首次启动仍会检查依赖；如果依赖缺失，脚本会自动执行：

\`\`\`bash
npm ci
\`\`\`

默认模型服务：

\`\`\`bash
ANTHROPIC_MODEL_PROVIDER=siliconflow
SILICONFLOW_BASE_URL=https://api.siliconflow.cn/v1
SILICONFLOW_MODEL=Qwen/Qwen3.6-35B-A3B
SILICONFLOW_API_KEY=你的APIKey
\`\`\`

部署包根目录已包含 \`.env\`，启动脚本会自动读取。换机器后只需要编辑这一行：

\`\`\`bash
nano .env
# 填入：SILICONFLOW_API_KEY=你的APIKey
./run-ubuntu-simple-web.sh
\`\`\`

如果已经在系统环境变量中配置了 \`SILICONFLOW_API_KEY\`，也可以直接启动：

\`\`\`bash
./run-ubuntu-simple-web.sh
\`\`\`

## 命令行检查

\`\`\`bash
bin/windrise-bash doctor
bin/windrise-bash "303804是什么故障，怎么处理"
\`\`\`

## 说明

这个包启动的是 \`simple_home.html\`，不是 \`hn/windrise_web_server.py\`。页面里保留：

- 思维链开关
- 普通问候不触发推理链
- 五个偏航液压问题推理链
- LLMWiki 知识图谱补充推理链
- 管理员页：PDF 问题对话提示、风电知识提问、复制问题按钮
- Windrise 故障码/LLMWiki/通用问答自动识别
`
}

function windriseBashEntry() {
  return `#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNNER="$ROOT/scripts/run-lmstudio-claude.mjs"
CHAT="$ROOT/scripts/windrise-chat.mjs"

if [[ -n "\${LLMWIKI_PROJECT:-}" ]]; then
  export LLMWIKI_PROJECT
fi
if [[ -n "\${LLMWIKI_DIR:-}" ]]; then
  export LLMWIKI_DIR
fi
export ANTHROPIC_MODEL_PROVIDER="\${ANTHROPIC_MODEL_PROVIDER:-siliconflow}"
export SILICONFLOW_BASE_URL="\${SILICONFLOW_BASE_URL:-https://api.siliconflow.cn/v1}"
export SILICONFLOW_MODEL="\${SILICONFLOW_MODEL:-Qwen/Qwen3.6-35B-A3B}"
export LMSTUDIO_CHAT_MODEL="\${LMSTUDIO_CHAT_MODEL:-$SILICONFLOW_MODEL}"
export LMSTUDIO_MODEL="\${LMSTUDIO_MODEL:-$SILICONFLOW_MODEL}"
export LMSTUDIO_FORCE_CHAT="\${LMSTUDIO_FORCE_CHAT:-1}"
export MAX_THINKING_TOKENS="\${MAX_THINKING_TOKENS:-0}"
export WINDRISE_ENABLE_THINKING="\${WINDRISE_ENABLE_THINKING:-0}"
export LMSTUDIO_BASE_URL="\${LMSTUDIO_BASE_URL:-$SILICONFLOW_BASE_URL}"
export DISABLE_INSTALLATION_CHECKS="\${DISABLE_INSTALLATION_CHECKS:-1}"
export WINDRISE=1

show_help() {
  cat <<'EOF'
windrise 用法:
  windrise                         启动 Windrise 完整交互界面
  windrise ask                     启动普通回车对话模式，按需检索
  windrise 303804                  单次对话/检索
  windrise "303804是什么故障"       自动检索知识库并总结
  windrise "llmwiki 303804"        明确检索知识库并总结
  windrise search 偏航 电机        直接检索多个关键词
  windrise trace 303804            显示问题到故障/元器件/机理的可视证据路径
  windrise web 最新 风机固件       联网搜索并总结
  windrise fetch https://example.com 抓取网页并总结
  windrise weather 北京            查询天气预报
  windrise read <路径>             读取 LLMWiki 文件
  windrise tree [路径]             查看 LLMWiki 目录树
  windrise skills                  查看本地离线 skills
  windrise doctor                  检查 SiliconFlow / LLMWiki 状态
  windrise chat                    启动完整交互模式
  windrise help                    显示帮助
EOF
}

run_llmwiki() {
  node "$RUNNER" --print --bare "$1"
}

search_query() {
  local query="$*"
  local code
  code="$(printf '%s' "$query" | grep -Eo '[0-9]{3,}' | head -n 1 || true)"

  if [[ -n "$code" ]]; then
    if is_bare_fault_code_query "$query" "$code"; then
      run_llmwiki "/llmwiki search $code --limit 8"
    else
      run_llmwiki "/llmwiki ask $query --limit 8"
    fi
    return
  fi

  run_llmwiki "/llmwiki search $query --limit 8"
}

is_bare_fault_code_query() {
  local query="$1"
  local code="$2"
  local rest
  rest="$(printf '%s' "$query" \\
    | sed "s/$code//" \\
    | sed -E 's/(故障码|故障代码|报警码|告警码|代码|fault[[:space:]]*code|是什么|啥|含义|原因|处理|复位|报警|故障|逻辑|怎么|如何|的|为|是)//Ig' \\
    | sed -E 's/[？?，,。.、:：[:space:]]//g')"
  [[ -z "$rest" ]]
}

run_chat() {
  export CLAUDE_CODE_FORCE_FULL_LOGO="\${CLAUDE_CODE_FORCE_FULL_LOGO:-1}"
  exec node "$RUNNER" "$@"
}

run_windrise_chat() {
  exec node "$CHAT" "$@"
}

answer_once() {
  local prompt="$*"
  printf '%s\\nexit\\n' "$prompt" | node "$CHAT"
}

is_knowledge_query() {
  local prompt="$*"
  if [[ "\${WINDRISE_DISABLE_AUTO_LLMWIKI:-}" == "1" ]] && ! is_explicit_llmwiki_query "$prompt"; then
    return 1
  fi
  if printf '%s' "$prompt" | grep -Eiq '^[[:space:]]*(故障码|代码|fault[[:space:]]*code)?[[:space:]]*[0-9]{3,}([是什么啥含义原因处理复位报警故障逻辑怎么如何？?，,。.、[:space:]]*)?$'; then
    return 0
  fi
  if printf '%s' "$prompt" | grep -Eq '[0-9]{3,}' \\
    && printf '%s' "$prompt" | grep -Eiq '(故障|报警|告警|停机|复位|原因|处理|排查|检查|维修|逻辑|怎么|如何|为什么|是什么|含义)'; then
    return 0
  fi
  if printf '%s' "$prompt" | grep -Eiq '(故障码|故障代码|报警码|告警码|fault[[:space:]]*code)'; then
    return 0
  fi
  if printf '%s' "$prompt" | grep -Eiq '(风机|风电|机组|变桨|偏航|风速仪|风向仪|主控|机舱|塔基|塔筒|叶片|轮毂|变流器|变频器|发电机|齿轮箱|液压|制动|刹车|安全链|电网|箱变|变压器|通信|通讯|水冷|冷却|传动|主轴|主轴承|传感器|振动|温度|润滑|油脂|SCADA|HMI|24v|plc|hw2s|华仪)' \\
    && printf '%s' "$prompt" | grep -Eiq '(故障|报警|告警|停机|复位|不可复位|原因|处理|排查|检查|维修|下一步|设置值|逻辑|反馈|断开|短路|断路|丢失|原理|机理|机制|工作方式|工作过程|运行方式|运行过程|控制逻辑|结构|组成|作用|用途|区别|关系|解释|介绍|怎么|如何|为什么|是什么|啥意思|含义|跳变|掉线|压力|流量)'; then
    return 0
  fi
  return 1
}

is_explicit_llmwiki_query() {
  local prompt="$*"
  printf '%s' "$prompt" | grep -Eiq '^[[:space:]]*/?(llmwiki|wiki)([[:space:]]|$)'
}

if [[ $# -eq 0 ]]; then
  run_chat
fi

case "$1" in
  help|-h|--help)
    show_help
    ;;
  chat)
    run_chat
    ;;
  ask)
    run_windrise_chat
    ;;
  skills)
    run_llmwiki "/lmstudio skills"
    ;;
  doctor)
    run_llmwiki "/lmstudio"
    ;;
  search)
    shift
    if [[ $# -eq 0 ]]; then
      echo "用法: windrise search <关键词>" >&2
      exit 2
    fi
    search_query "$@"
    ;;
  trace)
    shift
    if [[ $# -eq 0 ]]; then
      echo "用法: windrise trace <问题/故障码/元器件>" >&2
      exit 2
    fi
    run_llmwiki "/llmwiki trace $* --limit 6"
    ;;
  web)
    shift
    if [[ $# -eq 0 ]]; then
      echo "用法: windrise web <关键词>" >&2
      exit 2
    fi
    printf '%s\\nexit\\n' "web $*" | node "$CHAT"
    ;;
  fetch)
    shift
    if [[ $# -eq 0 ]]; then
      echo "用法: windrise fetch <URL>" >&2
      exit 2
    fi
    printf '%s\\nexit\\n' "fetch $*" | node "$CHAT"
    ;;
  weather)
    shift
    if [[ $# -eq 0 ]]; then
      echo "用法: windrise weather <城市>" >&2
      exit 2
    fi
    printf '%s\\nexit\\n' "weather $* 天气" | node "$CHAT"
    ;;
  read)
    shift
    if [[ $# -eq 0 ]]; then
      echo "用法: windrise read <LLMWiki路径>" >&2
      exit 2
    fi
    run_llmwiki "/llmwiki read $*"
    ;;
  tree)
    shift
    if [[ $# -eq 0 ]]; then
      run_llmwiki "/llmwiki tree --depth 2 --limit 50"
      exit 0
    fi
    run_llmwiki "/llmwiki tree $* --depth 2 --limit 50"
    ;;
  *)
    if is_knowledge_query "$*"; then
      printf '%s\\nexit\\n' "$*" | node "$CHAT"
      exit 0
    fi
    answer_once "$@"
    ;;
esac
`
}
