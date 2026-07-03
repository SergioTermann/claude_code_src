#!/usr/bin/env node

import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '_')
const defaultOut = join(root, 'offline-dist', `windrise-windows-web-${stamp}`)
const outDir = resolve(process.argv[2] || defaultOut)

const entries = [
  'package.json',
  'package-lock.json',
  'README.md',
  'simple_home.html',
  '启动Windrise网页.bat',
  'dist',
  'scripts',
  'bin',
  'types',
  'vendor',
  'assets',
  'wind-llmwiki',
  '风机故障码',
  'generated-knowledge',
  'node_modules',
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

await writeFile(join(outDir, 'README_Windows.md'), windowsReadme(), 'utf8')
await writeFile(join(outDir, '修复依赖.bat'), repairDepsBat(), 'utf8')
await normalizeWindowsScripts(outDir)
await writeFile(
  join(outDir, 'WINDOWS_PACKAGE_MANIFEST.json'),
  `${JSON.stringify({ createdAt: new Date().toISOString(), sourceRoot: root, packageRoot: outDir, copied }, null, 2)}\n`,
  'utf8',
)

console.log(`Windows web package written to ${outDir}`)
console.log(`Run on Windows: ${basename(outDir)}\\启动Windrise网页.bat`)

async function normalizeWindowsScripts(baseDir) {
  for (const relPath of ['启动Windrise网页.bat', '修复依赖.bat', join('bin', 'windrise.cmd')]) {
    const filePath = join(baseDir, relPath)
    if (!existsSync(filePath)) continue
    const content = await readFile(filePath, 'utf8')
    await writeFile(filePath, content.replace(/\r?\n/g, '\r\n'), 'utf8')
  }
}

function windowsReadme() {
  return `# Windrise Windows 网页运行包

## 运行方式

1. 在 Windows 上安装 Node.js 22 LTS 或更高版本。
2. 配置 SiliconFlow。
   - 默认地址：\`https://api.siliconflow.cn/v1\`
   - 默认模型名：\`Qwen/Qwen3.6-35B-A3B\`
3. 双击本目录下的 \`启动Windrise网页.bat\`。
4. 浏览器会自动打开：

\`\`\`
http://127.0.0.1:8766/simple_home.html
\`\`\`

## 修改模型配置

如果 SiliconFlow 模型名或 API Key 需要修改，先在同一个命令窗口里设置：

\`\`\`bat
set ANTHROPIC_MODEL_PROVIDER=siliconflow
set SILICONFLOW_BASE_URL=https://api.siliconflow.cn/v1
set SILICONFLOW_MODEL=你的模型名
set SILICONFLOW_API_KEY=你的APIKey
启动Windrise网页.bat
\`\`\`

## 命令行查询

\`\`\`bat
bin\\windrise.cmd doctor
bin\\windrise.cmd "303804是什么故障，怎么处理"
bin\\windrise.cmd search 偏航 电机
\`\`\`

## 如果启动失败

- 提示找不到 Node.js：安装 Node.js 后重新打开。
- 网页能打开但问答失败：确认 LM Studio Server 已启动，模型名和环境变量一致。
- 依赖缺失或 node_modules 不适配当前 Windows：双击 \`修复依赖.bat\`，它会执行 \`npm install\`。
`
}

function repairDepsBat() {
  return `@echo off
setlocal EnableExtensions
cd /d "%~dp0"
where npm >nul 2>nul
if errorlevel 1 (
  echo 未检测到 npm。请安装 Node.js 22 LTS 或更高版本。
  pause
  exit /b 1
)
echo 正在安装/修复依赖...
npm install
pause
`
}
