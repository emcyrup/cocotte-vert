// EPARK 管理画面を「見る」ための道具。**何も書き換えない。**
//
// 実物の画面が分からないとセレクタ（config/epark-profile.json）が書けない。
// これを一度流すと、ログイン後の画面のスクリーンショットと HTML が手元に落ちるので、
// それを見て設定を埋める。
//
// 使い方:
//   node --env-file-if-exists=.env scripts/epark-probe.js
//   node --env-file-if-exists=.env scripts/epark-probe.js --url='https://.../schedule?date=2026-09-01'
//   node --env-file-if-exists=.env scripts/epark-probe.js --headed --keep=180
//
// --headed  画面を出して動かす（手で操作して回れる。手元の PC でのみ使える）
// --keep=N  ログイン後 N 秒そのままにする。--headed と組み合わせて画面を見て回る用
// --out=DIR 保存先（既定 ./epark-probe）
//
// 落ちるもの: page-<連番>.png / page-<連番>.html / summary.txt
// **HTML にはお客様の氏名や電話番号が含まれることがある。** 外に出す前に必ず中身を確認し、
// 共有するときは伏せること。リポジトリにコミットしない（.gitignore 済み）。

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const headed = process.argv.includes('--headed');
const keepSeconds = Number(arg('keep', headed ? 120 : 0));
const outDir = arg('out', 'epark-probe');
const startUrl = arg('url');

const { loadConfig } = await import('../src/config.js');
// 見るだけなので EPARK_MODE=off のままでも動かせるようにする（config の検証を通すため補う）
if (!process.env.EPARK_MODE || process.env.EPARK_MODE === 'off') process.env.EPARK_MODE = 'dry_run';
const config = loadConfig();

if (!config.epark.user || !config.epark.password) {
  console.error('EPARK_USER / EPARK_PASSWORD を .env に設定してください');
  process.exit(1);
}
const loginUrl =
  arg('login', process.env.EPARK_LOGIN_URL) ||
  (config.epark.baseUrl ? `${config.epark.baseUrl.replace(/\/$/, '')}/login/index` : null);
if (!loginUrl) {
  console.error('EPARK_BASE_URL か EPARK_LOGIN_URL（または --login=）を指定してください');
  process.exit(1);
}

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('playwright が入っていません: npm install playwright && npx playwright install chromium');
  process.exit(1);
}

await mkdir(outDir, { recursive: true });
const notes = [];
let seq = 0;

const browser = await chromium.launch({
  headless: !headed,
  executablePath: config.epark.browserPath || undefined,
});
const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });

/** いまの画面を保存する。パスワード欄の中身は HTML に残らない（value は属性ではないため） */
async function capture(label) {
  seq += 1;
  const base = path.join(outDir, `page-${String(seq).padStart(2, '0')}`);
  await page.screenshot({ path: `${base}.png`, fullPage: true });
  await writeFile(`${base}.html`, await page.content(), 'utf8');
  const line = `${seq}. ${label}\n   url: ${page.url()}\n   files: ${base}.png / ${base}.html`;
  notes.push(line);
  console.log(line);
}

try {
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
  await capture('ログイン画面');

  // ログイン欄の当たりを付ける材料も残す（セレクタを書くときの手がかり）
  const fields = await page.locator('input, button, select').evaluateAll((els) =>
    els.slice(0, 40).map((el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type'),
      id: el.id || null,
      name: el.getAttribute('name'),
      placeholder: el.getAttribute('placeholder'),
      text: (el.textContent || '').trim().slice(0, 30) || null,
    }))
  );
  notes.push(`ログイン画面の入力欄:\n${JSON.stringify(fields, null, 2)}`);

  console.log('\nログインを試みます（--headed のときは画面が出ます）');
  console.log('※ 二要素認証があるとここで止まります。その場合は --headed で手で通してください\n');

  // 入力欄は id / name / type から推測する。分からなければ headed で手で入れてもらう
  const userField = page.locator('input[type="text"], input[type="email"], input[name*="id" i], input[name*="user" i]').first();
  const passField = page.locator('input[type="password"]').first();
  if ((await userField.count()) && (await passField.count())) {
    await userField.fill(config.epark.user);
    await passField.fill(config.epark.password);
    await page.locator('button[type="submit"], input[type="submit"], button:has-text("ログイン")').first().click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForTimeout(3000);
    await capture('ログイン後');
  } else {
    notes.push('入力欄を見つけられませんでした。--headed で手でログインしてください');
    console.log('入力欄を見つけられませんでした。--headed で手でログインしてください');
  }

  if (startUrl) {
    await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    await capture('指定された画面');
  }

  if (keepSeconds > 0) {
    console.log(`${keepSeconds}秒このままにします。閉じたい枠の画面まで手で進んでください…`);
    await page.waitForTimeout(keepSeconds * 1000);
    await capture('最後に開いていた画面');
  }
} finally {
  await writeFile(path.join(outDir, 'summary.txt'), notes.join('\n\n'), 'utf8');
  await browser.close();
}

console.log(`\n保存しました: ${outDir}/`);
console.log('※ HTML にお客様の情報が含まれることがあります。共有前に必ず中身を確認してください。');
