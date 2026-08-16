#!/usr/bin/env node
// スタッフ操作マニュアル（docs/staff-manual.md）を、店頭で配れる PDF に組む。
//
// 印刷して渡すことを前提にしているので、依存を増やさずに済ませてある。
// Markdown → HTML は必要な記法（見出し・表・箇条書き・引用・強調）だけを自前で変換し、
// PDF 化は Chrome / Chromium の --print-to-pdf に任せる。
//
//   node scripts/build-manual-pdf.js [出力先.pdf]
//
// Chrome の場所は CHROME_PATH で指定できる。未指定なら以下を順に探す。
import { readFileSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'docs', 'staff-manual.md');
const OUTPUT = path.resolve(process.argv[2] || path.join(ROOT, 'docs', 'staff-manual.pdf'));

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/opt/pw-browsers/chromium',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

// ---- Markdown → HTML -------------------------------------------------------

const escapeHtml = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 見出しの id。目次のリンク（#7-自動でお送りしているline 等）と揃える必要があるため、
// GitHub と同じ作り方にしてある: 小文字化 → 記号を落とす → 空白をハイフン
function slug(text) {
  return text
    .toLowerCase()
    .replace(/[`*_[\]()]/g, '')
    .replace(/[^\p{Letter}\p{Number}\p{Mark} _-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

function inline(text) {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return out;
}

const cell = (row) =>
  row.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

function renderTable(lines) {
  const [head, , ...body] = lines;
  const th = cell(head).map((c) => `<th>${inline(c)}</th>`).join('');
  const rows = body
    .map((r) => `<tr>${cell(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
    .join('');
  return `<table><thead><tr>${th}</tr></thead><tbody>${rows}</tbody></table>`;
}

// 箇条書きは1段のネストまで（マニュアルで使っている範囲）
function renderList(lines, ordered) {
  const tag = ordered ? 'ol' : 'ul';
  // 表や引用を挟んで続く番号付きリスト（「4. 保存を押す」など）が
  // 1 から振り直されないよう、書かれている番号から始める
  const first = ordered ? Number((lines[0].match(/^\s*(\d+)\./) || [])[1]) : NaN;
  let html = `<${tag}${first > 1 ? ` start="${first}"` : ''}>`;
  let nested = false;
  for (const line of lines) {
    const indented = /^\s{2,}[-*\d]/.test(line);
    const text = line.replace(/^\s*(?:[-*]|\d+\.)\s+/, '');
    if (indented && !nested) { html += '<ul>'; nested = true; }
    if (!indented && nested) { html += '</ul>'; nested = false; }
    html += `<li>${inline(text)}</li>`;
  }
  if (nested) html += '</ul>';
  return html + `</${tag}>`;
}

function mdToHtml(md) {
  const lines = md.split('\n');
  const out = [];
  let i = 0;
  let h2Seen = 0;

  const isTable = (n) => /^\|/.test(lines[n] || '') && /^\|[\s:|-]+\|$/.test(lines[n + 1] || '');

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i += 1; continue; }

    // 区切り線は章の切れ目にしか使っていない。改ページで表現するので線自体は出さない
    if (/^---+$/.test(line.trim())) { i += 1; continue; }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2];
      if (level === 2) h2Seen += 1;
      // 章の頭から新しいページにする（最初の章だけは表紙に続ける）
      const cls = level === 2 && h2Seen > 1 ? ' class="pb"' : '';
      out.push(`<h${level} id="${slug(text)}"${cls}>${inline(text)}</h${level}>`);
      i += 1;
      continue;
    }

    if (isTable(i)) {
      const block = [];
      while (i < lines.length && /^\|/.test(lines[i])) block.push(lines[i++]);
      out.push(renderTable(block));
      continue;
    }

    if (/^>\s?/.test(line)) {
      const block = [];
      while (i < lines.length && /^>/.test(lines[i])) block.push(lines[i++].replace(/^>\s?/, ''));
      // 引用の中身も同じ変換にかける（箇条書きを含むものがある）
      out.push(`<blockquote>${mdToHtml(block.join('\n'))}</blockquote>`);
      continue;
    }

    if (/^\s*(?:[-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const block = [];
      while (i < lines.length && (/^\s*(?:[-*]|\d+\.)\s+/.test(lines[i]) || /^\s{2,}\S/.test(lines[i]))) {
        block.push(lines[i++]);
      }
      out.push(renderList(block, ordered));
      continue;
    }

    // 段落。改行は原文どおり折り返す
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^[#>|]/.test(lines[i])
           && !/^\s*(?:[-*]|\d+\.)\s+/.test(lines[i]) && !/^---+$/.test(lines[i].trim())) {
      para.push(lines[i++]);
    }
    out.push(`<p>${para.map(inline).join('<br>')}</p>`);
  }
  return out.join('\n');
}

// ---- 組版 ------------------------------------------------------------------

const STYLE = `
/* 余白はページ番号の帯を確保するため printToPDF 側で指定する（ここで書くと二重になる） */
@page { size: A4; }
* { box-sizing: border-box; }
body {
  font-family: "Noto Sans CJK JP", "Hiragino Sans", "Yu Gothic", "IPAPGothic", sans-serif;
  font-size: 10.5pt; line-height: 1.75; color: #2b2723; margin: 0;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
}
h1 { font-size: 22pt; margin: 0 0 6mm; letter-spacing: .02em; }
h2 {
  font-size: 15pt; margin: 0 0 4mm; padding: 0 0 2mm;
  border-bottom: 2px solid #4a7c59; color: #2f5d43;
}
h2.pb { break-before: page; }
h3 { font-size: 12.5pt; margin: 7mm 0 2mm; color: #2f5d43; }
h4 { font-size: 11pt; margin: 5mm 0 1.5mm; }
h1, h2, h3, h4 { break-after: avoid; }
p { margin: 0 0 3mm; }
ul, ol { margin: 0 0 3mm; padding-left: 6mm; }
li { margin: 0 0 1mm; }
li > ul { margin: 1mm 0 0; }
a { color: #2f5d43; text-decoration: none; }
code {
  font-family: "Noto Sans Mono CJK JP", monospace; font-size: 9.5pt;
  background: #f1efe9; padding: 0 3px; border-radius: 3px;
}
strong { font-weight: 700; }
table {
  width: 100%; border-collapse: collapse; margin: 0 0 4mm;
  font-size: 9.5pt; break-inside: avoid;
}
th, td { border: 1px solid #d8d3c8; padding: 2mm 2.5mm; text-align: left; vertical-align: top; }
th { background: #eef2ec; font-weight: 700; }
blockquote {
  margin: 0 0 4mm; padding: 3mm 4mm; background: #fdf7e8;
  border-left: 3px solid #d9a441; break-inside: avoid;
}
blockquote p:last-child, blockquote ul:last-child, blockquote ol:last-child { margin-bottom: 0; }
.cover { break-after: page; padding-top: 40mm; text-align: center; }
.cover .name { font-size: 28pt; font-weight: 700; letter-spacing: .06em; }
.cover .lead { margin-top: 8mm; font-size: 11pt; line-height: 2; color: #5b544c; }
.cover .box {
  margin: 20mm auto 0; max-width: 120mm; padding: 6mm;
  border: 1px solid #d8d3c8; border-radius: 4px; text-align: left; font-size: 10pt;
}
.cover .box b { display: block; margin-bottom: 2mm; color: #2f5d43; }
/* 目次のページ番号。リーダー線で見出しと数字をつなぐ */
.toc li { display: flex; align-items: baseline; gap: 2mm; list-style: none; }
.toc { padding-left: 2mm; }
.toc .dots { flex: 1; border-bottom: 1px dotted #cfc9bd; transform: translateY(-1mm); }
.toc .pg { font-variant-numeric: tabular-nums; color: #2b2723; }
`;

function cover(storeName) {
  // 表紙は Markdown 側に置かず、ここで組む（画面で読むときに邪魔になるため）
  return `
<div class="cover">
  <div class="name">スタッフ操作マニュアル</div>
  <div class="lead">${escapeHtml(storeName)}<br>予約・お客様情報・LINE配信の管理画面</div>
  <div class="box">
    <b>この冊子の読み方</b>
    はじめから読む必要はありません。<br>
    「こんなときどうする」の順に並べてあるので、目次から探してください。<br>
    分からなくなったら、最後の「困ったとき」を見てください。
  </div>
</div>`;
}

const page = (bodyHtml) => `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<title>スタッフ操作マニュアル</title>
<style>${STYLE}</style>
</head><body>${bodyHtml}</body></html>`;

// 目次の各項目に、その章が始まるページ番号を入れる。
// 番号は printToPDF の結果から数えるので、ここでは差し込むだけ。
function numberToc(html, pageOf) {
  return html.replace(
    /<ul>(\s*<li><a href="#[^"]+">[\s\S]*?)<\/ul>/,
    (all, items) => {
      if (!/<li><a href="#/.test(items)) return all;
      const numbered = items.replace(
        /<li>(<a href="#([^"]+)">[\s\S]*?<\/a>)<\/li>/g,
        (li, link, id) => {
          const n = pageOf.get(id);
          return n ? `<li>${link}<span class="dots"></span><span class="pg">${n}</span></li>` : li;
        }
      );
      return `<ul class="toc">${numbered}</ul>`;
    }
  );
}

// ---- 実行 ------------------------------------------------------------------

const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) {
  console.error('Chrome / Chromium が見つかりません。CHROME_PATH で指定してください。');
  process.exit(1);
}

// 章（## 見出し）ごとに分ける。目次のページ番号を出すのに、章単位で刷って
// ページ数を数える必要があるため
const md = readFileSync(SOURCE, 'utf8').replace(/^# .*\n/, '');
const parts = md.split(/\n(?=## )/);
const front = parts.slice(0, 2).join('\n');   // 導入文と目次（表紙の次のページ）
const chapters = parts.slice(2);
const storeName = process.env.STORE_NAME || 'ここっとベール';

const work = mkdtempSync(path.join(tmpdir(), 'manual-'));

// --print-to-pdf（コマンドライン）ではページ番号を入れられないため、
// DevTools プロトコル経由で Page.printToPDF を呼び、フッタを自前で指定する。
// 冊子として配る以上、「◯ページを見て」と言えることを優先した。
const FOOTER = `
<div style="width:100%;font-size:8pt;color:#8a8279;font-family:sans-serif;
            padding:0 14mm;display:flex;justify-content:space-between">
  <span>スタッフ操作マニュアル</span>
  <span><span class="pageNumber"></span> / <span class="totalPages"></span></span>
</div>`;

async function cdp(port, run) {
  // 起動直後は待ち受けていないことがあるので、繋がるまで少し粘る
  let target = null;
  for (let i = 0; i < 50 && !target; i += 1) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch { /* まだ起動していない */ }
    if (!target) await new Promise((r) => setTimeout(r, 200));
  }
  if (!target) throw new Error('Chrome の DevTools に接続できませんでした');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result);
  };
  const send = (method, params = {}) => new Promise((res, rej) => {
    id += 1;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
  try {
    return await run(send);
  } finally {
    ws.close();
  }
}

const PRINT = {
  printBackground: true,
  paperWidth: 8.27,       // A4
  paperHeight: 11.69,
  marginTop: 0.63, marginBottom: 0.71, marginLeft: 0.55, marginRight: 0.55,
  displayHeaderFooter: true,
  headerTemplate: '<span></span>',
  footerTemplate: FOOTER,
};

const port = 9333;
const child = spawn(chrome, [
  '--headless',
  '--disable-gpu',
  '--no-sandbox',
  `--remote-debugging-port=${port}`,
  '--remote-allow-origins=*',
  'about:blank',
], { stdio: 'ignore' });

let n = 0;
/** HTML を1枚刷って、PDF のバイト列を返す */
async function print(send, html) {
  n += 1;
  const file = path.join(work, `part-${n}.html`);
  writeFileSync(file, html);
  const { frameId } = await send('Page.navigate', { url: `file://${file}` });
  // loadEventFired を待たずに刷ると、フォントが載る前の状態が出る
  await new Promise((r) => setTimeout(r, 400));
  void frameId;
  const { data } = await send('Page.printToPDF', PRINT);
  return Buffer.from(data, 'base64');
}
// Chromium が吐く PDF は素直な構造なので、ページ数はオブジェクトの数で足りる
const pageCount = (buf) => (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;

try {
  const pdf = await cdp(port, async (send) => {
    await send('Page.enable');

    // 1回目: 章ごとに刷ってページ数を数え、目次に入れる番号を出す。
    // 章は必ずページの先頭から始まる（h2 に break-before: page）ので、
    // 単独で刷ったときの区切りが本番と一致する
    const pageOf = new Map();
    // 表紙は front の刷り上がりに含まれているので、ここで足さない
    let at = pageCount(await print(send, page(cover(storeName) + mdToHtml(front))));
    for (const chapter of chapters) {
      const title = chapter.match(/^##\s+(.*)$/m)[1];
      pageOf.set(slug(title), at + 1);
      at += pageCount(await print(send, page(mdToHtml(chapter))));
    }

    // 2回目: 番号を入れた目次で本番を刷る
    const html = page(cover(storeName) + numberToc(mdToHtml(md), pageOf));
    if (process.env.MANUAL_KEEP_HTML) {
      writeFileSync(process.env.MANUAL_KEEP_HTML, html);
      console.log(`HTML: ${process.env.MANUAL_KEEP_HTML}`);
    }
    return print(send, html);
  });
  writeFileSync(OUTPUT, pdf);
  console.log(`PDF を書き出しました: ${OUTPUT}（${pageCount(pdf)}ページ）`);
} finally {
  child.kill();
  rmSync(work, { recursive: true, force: true });
}
