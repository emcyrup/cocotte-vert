// EPARK 管理画面の設定が実物と合っているかを確かめる。**何も書き換えない。**
//
// データベースにも接続しない。ログインして、指定した日の受付表を読み、
// 枠ごとの状態を並べて出すだけ。だから**手元に何も用意できない環境でも動く**
// （GitHub Actions から流せる。.github/workflows/epark-check.yml）。
//
// 使い方:
//   node scripts/epark-check.js                    # 今日
//   node scripts/epark-check.js --date=2026-09-01
//   node scripts/epark-check.js --from=09:00 --to=20:00
//
// 出す情報は「時刻」と「開いているか」だけで、**お客様の氏名や電話番号は出さない**。
// そのまま貼って相談できる（管理画面の HTML を丸ごと送る epark-probe.js より安全）。

import { readFile } from 'node:fs/promises';

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

// 読むだけなので EPARK_MODE=off のままでも動かせるようにする（config の検証を通すため）
if (!process.env.EPARK_MODE || process.env.EPARK_MODE === 'off') process.env.EPARK_MODE = 'dry_run';

const { loadConfig } = await import('../src/config.js');
const { loadProfile, validateProfile } = await import('../src/epark/profile.js');
const { createBrowserDriver } = await import('../src/epark/browserDriver.js');

const config = loadConfig();
if (!config.epark.user || !config.epark.password) {
  console.error('EPARK_USER / EPARK_PASSWORD を設定してください');
  process.exit(1);
}

const profile = await loadProfile(config.epark.profilePath, readFile, config.epark.baseUrl).catch(
  (err) => {
    console.error(`画面設定を読めません（${config.epark.profilePath}）: ${err.message}`);
    return null;
  }
);
if (!profile) process.exit(1);

const check = validateProfile(profile);
if (!check.ok) {
  console.error(`画面設定が不正です: ${check.error}`);
  process.exit(1);
}

// 日付は JST で決める（サーバーの TZ に引きずられない）
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(new Date());
const date = arg('date', today);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error(`--date は YYYY-MM-DD で指定してください（受け取った値: ${date}）`);
  process.exit(1);
}

const slotMinutes = profile.slotMinutes ?? 60;
const toMinutes = (t) => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};
const times = [];
for (let at = toMinutes(arg('from', '08:00')); at <= toMinutes(arg('to', '21:00')); at += slotMinutes) {
  times.push(`${String(Math.floor(at / 60)).padStart(2, '0')}:${String(at % 60).padStart(2, '0')}`);
}

const LABEL = { closed: '閉（仮受付など）', open: '開（受付中）', none: '― 枠なし' };

const driver = createBrowserDriver({ profile, config });
let broken = 0;
try {
  console.log(`ログインします（${profile.loginUrl}）`);
  await driver.open();
  console.log('ログインできました\n');

  for (const line of profile.lines) {
    const rows = await driver.readDay({ date, lineId: line.id, times });
    const found = rows.filter((r) => r.state !== 'none').length;
    console.log(`${date}  ${line._name ?? `line=${line.id}`}（line=${line.id}） 枠 ${found}/${rows.length}`);
    for (const r of rows) {
      const mark = r.state === 'closed' ? (r.ours ? '  ← 仮受付の印あり' : '  ← 仮受付の印なし（ご予約？）') : '';
      console.log(`  ${r.time}  ${LABEL[r.state]}${mark}`);
    }
    if (found === 0) broken += 1;
    console.log('');
  }
} catch (err) {
  console.error(`\n失敗しました: ${err.message}`);
  process.exitCode = 1;
} finally {
  await driver.close().catch(() => {});
}

if (broken > 0) {
  console.error(
    `枠を1つも読めなかったラインが ${broken} 件あります。` +
      'config/epark-profile.json の cell.* か day.* が実物と合っていません'
  );
  process.exitCode = 1;
} else if (!process.exitCode) {
  console.log('画面設定は実物と合っています。EPARK_MODE=dry_run で本番の流れを試せます');
}
