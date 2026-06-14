#!/usr/bin/env node

import { createServer } from 'http'
import { execFile } from 'child_process'
import { createReadStream } from 'fs'
import { mkdir, readFile, stat, writeFile } from 'fs/promises'
import { extname, join, normalize, relative, resolve, sep } from 'path'
import { fileURLToPath } from 'url'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const UPLOAD_DIR = join(ROOT, 'generated-knowledge', 'uploads')
const OUT_DIR = join(ROOT, 'generated-knowledge')
const PORT = Number.parseInt(process.env.DOC_KNOWLEDGE_PORT || '8765', 10)
const MAX_UPLOAD_BYTES = Number.parseInt(
  process.env.DOC_KNOWLEDGE_MAX_UPLOAD_BYTES || String(200 * 1024 * 1024),
  10,
)

await mkdir(UPLOAD_DIR, { recursive: true })
await mkdir(OUT_DIR, { recursive: true })

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    if (req.method === 'GET' && url.pathname === '/') {
      return sendHtml(res, renderUploadPage())
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, { ok: true })
    }
    if (req.method === 'POST' && url.pathname === '/api/upload') {
      return handleUpload(req, res)
    }
    if (req.method === 'GET' && url.pathname.startsWith('/generated/')) {
      return serveGeneratedFile(url.pathname, res)
    }
    sendText(res, 404, 'Not found')
  } catch (error) {
    sendText(res, 500, `Server error: ${error.message}`)
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Document knowledge upload server: http://127.0.0.1:${PORT}`)
})

async function handleUpload(req, res) {
  const contentType = req.headers['content-type'] || ''
  const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[1] ?? contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.[2]
  if (!boundary) return sendText(res, 400, 'Missing multipart boundary')

  const body = await readRequestBody(req)
  const file = parseMultipartFile(body, boundary)
  if (!file) return sendText(res, 400, 'Missing file field')

  const ext = extname(file.filename).toLowerCase()
  if (!/\.(pdf|md|markdown|txt|csv|json|jsonl)$/i.test(file.filename)) {
    return sendText(res, 400, `Unsupported file type: ${ext || 'unknown'}`)
  }

  const safeName = safeFileName(file.filename)
  const uploadedPath = join(UPLOAD_DIR, `${Date.now()}_${safeName}`)
  await writeFile(uploadedPath, file.content)

  const { stdout, stderr } = await execFileAsync(
    'node',
    [join(ROOT, 'scripts', 'build-doc-knowledge.mjs'), uploadedPath, '--out', OUT_DIR],
    {
      cwd: ROOT,
      maxBuffer: 1024 * 1024 * 20,
    },
  )

  const projectPath = extractProjectPath(stdout)
  if (!projectPath) {
    return sendText(res, 500, `Build finished but project path was not found.\n${stdout}\n${stderr}`)
  }

  const projectRel = relative(OUT_DIR, projectPath)
  const visualizationUrl = `/generated/${encodePath(join(projectRel, 'graph', 'visualization.html'))}`
  const indexUrl = `/generated/${encodePath(join(projectRel, 'wiki', 'index.md'))}`
  const graphUrl = `/generated/${encodePath(join(projectRel, 'graph', 'knowledge-graph.json'))}`

  sendHtml(
    res,
    renderResultPage({
      filename: file.filename,
      stdout,
      stderr,
      projectPath,
      visualizationUrl,
      indexUrl,
      graphUrl,
    }),
  )
}

async function readRequestBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_UPLOAD_BYTES) {
      throw new Error(`Upload exceeds limit: ${MAX_UPLOAD_BYTES} bytes`)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function parseMultipartFile(body, boundary) {
  const delimiter = Buffer.from(`--${boundary}`)
  const parts = splitBuffer(body, delimiter)
  for (const part of parts) {
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'))
    if (headerEnd < 0) continue
    const rawHeaders = part.slice(0, headerEnd).toString('utf8')
    if (!/name="file"/.test(rawHeaders)) continue
    const filename = rawHeaders.match(/filename="([^"]*)"/)?.[1]
    if (!filename) continue
    let content = part.slice(headerEnd + 4)
    if (content.subarray(0, 2).toString() === '\r\n') content = content.subarray(2)
    if (content.subarray(-2).toString() === '\r\n') content = content.subarray(0, -2)
    if (content.subarray(-2).toString() === '--') content = content.subarray(0, -2)
    return {
      filename,
      content,
    }
  }
  return null
}

function splitBuffer(buffer, delimiter) {
  const parts = []
  let start = 0
  while (true) {
    const index = buffer.indexOf(delimiter, start)
    if (index < 0) {
      parts.push(buffer.subarray(start))
      break
    }
    if (index > start) parts.push(buffer.subarray(start, index))
    start = index + delimiter.length
  }
  return parts
    .map(part => {
      let value = part
      if (value.subarray(0, 2).toString() === '\r\n') value = value.subarray(2)
      if (value.subarray(-2).toString() === '\r\n') value = value.subarray(0, -2)
      return value
    })
    .filter(part => part.length > 0 && part.toString('utf8').trim() !== '--')
}

async function serveGeneratedFile(pathname, res) {
  const rel = decodeURIComponent(pathname.slice('/generated/'.length))
  const filePath = resolve(OUT_DIR, normalize(rel))
  if (!isInside(OUT_DIR, filePath)) return sendText(res, 403, 'Forbidden')
  const info = await stat(filePath).catch(() => null)
  if (!info?.isFile()) return sendText(res, 404, 'Not found')

  res.writeHead(200, {
    'content-type': contentType(filePath),
    'content-length': info.size,
  })
  createReadStream(filePath).pipe(res)
}

function extractProjectPath(stdout) {
  return stdout.match(/Built document LLMWiki:\s*(.+)/)?.[1]?.trim()
}

function renderUploadPage() {
  return page(
    '文档知识图谱上传',
    `
      <section class="panel">
        <h1>文档知识图谱</h1>
        <form action="/api/upload" method="post" enctype="multipart/form-data">
          <input class="file" name="file" type="file" accept=".pdf,.md,.markdown,.txt,.csv,.json,.jsonl" required>
          <button type="submit">上传并生成</button>
        </form>
        <p>支持 PDF、Markdown、TXT、CSV、JSON、JSONL。生成结果会保存在 <code>generated-knowledge/</code>。</p>
      </section>
    `,
  )
}

function renderResultPage(result) {
  return page(
    '生成完成',
    `
      <section class="panel">
        <h1>生成完成</h1>
        <div class="kv"><span>文件</span><b>${escapeHtml(result.filename)}</b></div>
        <div class="kv"><span>项目路径</span><code>${escapeHtml(result.projectPath)}</code></div>
        <div class="actions">
          <a class="button" href="${result.visualizationUrl}" target="_blank">打开知识图谱可视化</a>
          <a class="button secondary" href="${result.indexUrl}" target="_blank">查看 Wiki 首页</a>
          <a class="button secondary" href="${result.graphUrl}" target="_blank">查看 Graph JSON</a>
          <a class="button secondary" href="/">继续上传</a>
        </div>
        <details>
          <summary>构建日志</summary>
          <pre>${escapeHtml(result.stdout)}${escapeHtml(result.stderr || '')}</pre>
        </details>
      </section>
    `,
  )
}

function page(title, body) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body{margin:0;background:#f6f7f9;color:#202938;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
    .panel{max-width:760px;margin:56px auto;background:white;border:1px solid #d8dee8;border-radius:8px;padding:24px}
    h1{margin:0 0 18px;font-size:24px}
    form{display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center}
    .file{height:42px;border:1px solid #d8dee8;border-radius:6px;padding:8px;background:#fff}
    button,.button{height:42px;border:1px solid #1d4ed8;background:#2563eb;color:white;border-radius:6px;padding:0 14px;display:inline-flex;align-items:center;text-decoration:none;font-size:14px;cursor:pointer}
    .secondary{background:#fff;color:#202938;border-color:#d8dee8}
    p{color:#667085;line-height:1.6}
    code{background:#f1f4f8;border:1px solid #d8dee8;border-radius:4px;padding:2px 5px}
    .kv{display:grid;grid-template-columns:80px 1fr;gap:12px;margin:10px 0;align-items:start}
    .kv span{color:#667085}
    .actions{display:flex;flex-wrap:wrap;gap:10px;margin:20px 0}
    pre{white-space:pre-wrap;background:#111827;color:#e5e7eb;border-radius:6px;padding:12px;overflow:auto}
    @media(max-width:720px){.panel{margin:16px;border-left:0;border-right:0;border-radius:0}form{grid-template-columns:1fr}.button,button{justify-content:center}}
  </style>
</head>
<body>${body}</body>
</html>`
}

function sendHtml(res, html) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(html)
}

function sendJson(res, value) {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

function sendText(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(text)
}

function contentType(filePath) {
  const ext = extname(filePath).toLowerCase()
  return (
    {
      '.html': 'text/html; charset=utf-8',
      '.md': 'text/markdown; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.jsonl': 'application/jsonl; charset=utf-8',
      '.csv': 'text/csv; charset=utf-8',
      '.txt': 'text/plain; charset=utf-8',
    }[ext] ?? 'application/octet-stream'
  )
}

function safeFileName(value) {
  return basename(value)
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 120)
}

function encodePath(value) {
  return value.split(sep).map(encodeURIComponent).join('/')
}

function isInside(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (!rel.startsWith('..') && !resolve(rel).startsWith(sep))
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char])
}
