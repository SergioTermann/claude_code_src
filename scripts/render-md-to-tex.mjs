import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [inputPath, outputPath] = process.argv.slice(2);

if (!inputPath || !outputPath) {
  console.error('Usage: node scripts/render-md-to-tex.mjs <input.md> <output.tex>');
  process.exit(1);
}

const source = await readFile(inputPath, 'utf8');
const lines = source.split(/\r?\n/);

function escapeLatex(value) {
  return String(value)
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([#$%&_{}])/g, '\\$1')
    .replace(/\^/g, '\\textasciicircum{}')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/≤/g, '$\\le$')
    .replace(/≥/g, '$\\ge$')
    .replace(/℃/g, '$^\\circ$C')
    .replace(/Φ/g, '$\\Phi$');
}

function inlineMarkdown(value) {
  const chunks = [];
  const pattern = /\*\*(.+?)\*\*/g;
  let cursor = 0;
  let match;
  while ((match = pattern.exec(value)) !== null) {
    chunks.push(escapeLatex(value.slice(cursor, match.index)));
    chunks.push(`\\textbf{${escapeLatex(match[1])}}`);
    cursor = match.index + match[0].length;
  }
  chunks.push(escapeLatex(value.slice(cursor)));
  return chunks.join('');
}

function stripBoldLabel(value, label) {
  return value.replace(new RegExp(`^\\s*\\*\\*${label}：\\*\\*\\s*`), '').trim();
}

const body = [];
let title = '';
let inItemize = false;
let inQuote = false;

function closeItemize() {
  if (inItemize) {
    body.push('\\end{itemize}');
    inItemize = false;
  }
}

function closeQuote() {
  if (inQuote) {
    body.push('\\end{quote}');
    inQuote = false;
  }
}

function closeBlocks() {
  closeItemize();
  closeQuote();
}

for (const rawLine of lines) {
  const line = rawLine.trimEnd();
  const trimmed = line.trim();

  if (!trimmed) {
    closeItemize();
    closeQuote();
    body.push('');
    continue;
  }

  if (trimmed.startsWith('# ')) {
    title = trimmed.slice(2).trim();
    continue;
  }

  if (trimmed.startsWith('## ')) {
    closeBlocks();
    body.push(`\\section*{${inlineMarkdown(trimmed.slice(3).trim())}}`);
    body.push('\\addcontentsline{toc}{section}{' + inlineMarkdown(trimmed.slice(3).trim()) + '}');
    continue;
  }

  if (trimmed.startsWith('### ')) {
    closeBlocks();
    body.push(`\\subsection*{${inlineMarkdown(trimmed.slice(4).trim())}}`);
    continue;
  }

  if (trimmed.startsWith('> ')) {
    closeItemize();
    if (!inQuote) {
      body.push('\\begin{quote}');
      inQuote = true;
    }
    body.push(inlineMarkdown(trimmed.slice(2)));
    body.push('\\\\');
    continue;
  }

  if (trimmed.startsWith('- **问题：**')) {
    closeBlocks();
    body.push(`\\qaquestion{${inlineMarkdown(stripBoldLabel(trimmed.slice(1).trim(), '问题'))}}`);
    continue;
  }

  if (trimmed.startsWith('**回答要点：**')) {
    closeBlocks();
    body.push(`\\qaanswer{${inlineMarkdown(stripBoldLabel(trimmed, '回答要点'))}}`);
    continue;
  }

  if (trimmed.startsWith('- ')) {
    closeQuote();
    if (!inItemize) {
      body.push('\\begin{itemize}');
      inItemize = true;
    }
    body.push(`\\item ${inlineMarkdown(trimmed.slice(2).trim())}`);
    continue;
  }

  closeBlocks();
  body.push(inlineMarkdown(trimmed));
  body.push('\\par');
}

closeBlocks();

const tex = String.raw`\documentclass[11pt,a4paper]{article}
\usepackage[margin=2.2cm]{geometry}
\usepackage{fontspec}
\usepackage{xeCJK}
\usepackage{xcolor}
\usepackage{hyperref}
\usepackage{enumitem}
\usepackage{fancyhdr}
\usepackage{titlesec}
\IfFontExistsTF{Songti SC}{\setCJKmainfont{Songti SC}[AutoFakeBold=true]}{\IfFontExistsTF{PingFang SC}{\setCJKmainfont{PingFang SC}[AutoFakeBold=true]}{\setCJKmainfont{Arial Unicode MS}[AutoFakeBold=true]}}
\IfFontExistsTF{Times New Roman}{\setmainfont{Times New Roman}}{}
\definecolor{windblue}{HTML}{155E75}
\definecolor{questionbg}{HTML}{EFF6FF}
\definecolor{answerbg}{HTML}{F0FDF4}
\hypersetup{colorlinks=true, linkcolor=windblue, urlcolor=windblue}
\setlength{\parindent}{0pt}
\setlength{\parskip}{0.55em}
\setlist[itemize]{leftmargin=1.6em,itemsep=0.25em}
\pagestyle{fancy}
\fancyhf{}
\lhead{偏航液压系统压力异常故障处理问题串汇总}
\rhead{\thepage}
\titleformat{\section}{\Large\bfseries\color{windblue}}{}{0pt}{}
\titleformat{\subsection}{\large\bfseries}{}{0pt}{}
\newcommand{\qaquestion}[1]{%
  \vspace{0.45em}
  \noindent\colorbox{questionbg}{\parbox{\dimexpr\linewidth-2\fboxsep\relax}{\textbf{问题：}#1}}
  \par\vspace{0.15em}
}
\newcommand{\qaanswer}[1]{%
  \noindent\colorbox{answerbg}{\parbox{\dimexpr\linewidth-2\fboxsep\relax}{\textbf{回答要点：}#1}}
  \par\vspace{0.35em}
}
\begin{document}
\begin{center}
{\LARGE\bfseries ${escapeLatex(title || path.basename(inputPath, '.md'))}}\par
\vspace{0.8em}
{\small 由 Markdown 重新生成}
\end{center}
\vspace{0.8em}
${body.join('\n')}
\end{document}
`;

await writeFile(outputPath, tex, 'utf8');
