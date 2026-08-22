import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  requiredRows, sendModeRows, urlRows, optionalRows, storeRows, hasProblem, presence,
  duplicateKeys, duplicateRows,
} from '../src/checkEnv.js';

const SECRET = 'sk-ant-himitsu-0123456789';

const config = {
  line: { channelAccessToken: SECRET, channelSecret: SECRET },
  sendMode: 'dry_run',
  testLineUserId: null,
  staffNotifyChannel: 'line',
  slackWebhookUrl: null,
  staffLineGroupId: null,
  publicBaseUrl: 'https://example.test',
  port: 8017,
  liffUrl: 'https://liff.line.me/1-a',
  liffReserveUrl: 'https://liff.line.me/1-a/reserve.html',
  liffStaffUrl: 'https://liff.line.me/1-a/staff.html',
  liffStaffReserveUrl: 'https://liff.line.me/1-a/staff-reserve.html',
  anthropicApiKey: SECRET,
  igPostMode: 'dry_run',
  threadsPostMode: 'dry_run',
  x: { apiKey: null, apiSecret: null, accessToken: null, accessSecret: null, postMode: 'dry_run' },
  wordpress: { baseUrl: null, user: null, appPassword: null, status: 'draft', postMode: 'dry_run' },
  adminUser: 'admin', adminPassword: SECRET,
  ingestApiToken: SECRET,
  preReminderDaysBefore: 2, afterVisitDaysAfter: 7, dormantDays: 90, dormantDailyLimit: 50,
};

const store = { name: 'ここっとベール', openTime: '10:00', closeTime: '19:00', closedDayLabel: '木曜' };

const okChecks = {
  db: { ok: true, detail: 'cocotte_vert / 適用済み 014_reservation_draft_stay.sql' },
  line: { ok: true, detail: 'ここっとベール @abc / 応答モード: Bot' },
  anthropic: { ok: true, detail: 'ok' },
  instagram: { ok: true, detail: '@cocotte' },
  threads: { ok: true, detail: '@cocotte' },
};

const allRows = (c = config, checks = okChecks) => [
  ...requiredRows(c, checks), ...sendModeRows(c), ...urlRows(c),
  ...optionalRows(c, checks), ...storeRows(c, store),
];

// ---- 秘密を出さない ----

test('どの行にも秘密の値を出さない', () => {
  const text = allRows().join('\n');
  assert.doesNotMatch(text, /himitsu/, '設定値そのものを出してはいけない');
  assert.match(text, /設定あり/, '有無だけは分かるようにする');
});

test('未設定のものも、値ではなく状態で言う', () => {
  assert.equal(presence(null), '未設定');
  assert.equal(presence(SECRET), '設定あり');
});

// ---- 必須 ----

test('必須が通れば ✓、落ちれば ✗', () => {
  assert.equal(hasProblem(requiredRows(config, okChecks)), false);

  const ng = { ...okChecks, db: { ok: false, detail: 'ECONNREFUSED' } };
  const rows = requiredRows(config, ng);
  assert.equal(hasProblem(rows), true);
  assert.match(rows.join('\n'), /接続できません: ECONNREFUSED/);
});

test('LINE トークンが無効なら、その理由を出す', () => {
  const ng = { ...okChecks, line: { ok: false, detail: 'HTTP 401' } };
  assert.match(requiredRows(config, ng).join('\n'), /✗ LINE アクセストークン.*HTTP 401/);
});

// ---- 誤爆に関わる設定 ----

test('live のときは警告として出す（見落とすと本番送信になる）', () => {
  const rows = sendModeRows({ ...config, sendMode: 'live' }).join('\n');
  assert.match(rows, /! SEND_MODE: live/);
  assert.match(rows, /お客様へ実際に届きます/);
});

test('dry_run と test は問題として扱わない', () => {
  assert.equal(hasProblem(sendModeRows(config)), false);
  assert.equal(
    hasProblem(sendModeRows({ ...config, sendMode: 'test', testLineUserId: 'U1' })), false
  );
});

test('Slack を使う設定なのに Webhook が無ければ ✗', () => {
  const rows = sendModeRows({ ...config, staffNotifyChannel: 'slack' });
  assert.equal(hasProblem(rows), true);
  // 叩くと通知が飛ぶので、疎通は確認しないことを明示する
  assert.match(rows.join('\n'), /疎通は確認しません/);
});

// ---- URL ----

test('LIFF の各ページを個別に出す（新しい画面の設定漏れに気付けるように）', () => {
  const rows = urlRows(config).join('\n');
  for (const label of ['お客様の登録フォーム', 'お客様の予約フォーム', 'スタッフ登録', 'スタッフの予約登録フォーム']) {
    assert.match(rows, new RegExp(label), label);
  }
  assert.match(rows, /待ち受けポート: 8017/);
});

test('LIFF_ID が無ければ、どの画面も使えないと分かる', () => {
  const none = { ...config, liffUrl: null, liffReserveUrl: null, liffStaffUrl: null, liffStaffReserveUrl: null };
  assert.equal(hasProblem(urlRows(none)), true);
});

test('PUBLIC_BASE_URL が無いのは警告どまり（アプリは動く）', () => {
  const rows = urlRows({ ...config, publicBaseUrl: null });
  assert.equal(hasProblem(rows), false);
  assert.match(rows.join('\n'), /! PUBLIC_BASE_URL/);
});

// ---- 任意の連携 ----

test('未設定の連携は問題にしない', () => {
  const bare = { ...config, anthropicApiKey: null };
  const checks = { ...okChecks, instagram: { skipped: true }, threads: { skipped: true } };
  const rows = optionalRows(bare, checks);
  assert.equal(hasProblem(rows), false);
  assert.match(rows.join('\n'), /- Claude API: 未設定/);
});

test('設定されているのに確認できない連携は ✗', () => {
  const checks = { ...okChecks, anthropic: { ok: false, detail: 'HTTP 401' } };
  const rows = optionalRows(config, checks);
  assert.equal(hasProblem(rows), true);
  assert.match(rows.join('\n'), /✗ Claude API.*HTTP 401/);
});

test('管理画面の認証が無ければ警告する（画面が開けなくなる）', () => {
  const rows = optionalRows({ ...config, adminUser: null, adminPassword: null }, okChecks);
  assert.match(rows.join('\n'), /! 管理画面の認証: 未設定/);
});

test('X は4つ揃って初めて設定ありとする', () => {
  const partial = { ...config, x: { ...config.x, apiKey: 'k', apiSecret: 's' } };
  assert.match(optionalRows(partial, okChecks).join('\n'), /- X: 未設定/);

  const full = { ...config, x: { apiKey: 'k', apiSecret: 's', accessToken: 'a', accessSecret: 'b', postMode: 'dry_run' } };
  assert.match(optionalRows(full, okChecks).join('\n'), /✓ X: 4つとも設定あり/);
});

// ---- 店舗 ----

test('配信の起点となる日数を出す（店舗ごとに変わるため）', () => {
  const rows = storeRows(config, store).join('\n');
  assert.match(rows, /前々日確認: 2日前/);
  assert.match(rows, /来店フォロー: 7日後/);
  assert.match(rows, /休眠フォロー: 90日で対象／1日 50件まで/);
  assert.match(rows, /営業時間: 10:00〜19:00/);
});

// ---- .env の重複（実際に本番で踏んだ） ----

test('同じキーが2行以上あれば見つける', () => {
  const env = [
    'DATABASE_URL=postgres://ai_labo_dbuser:x@127.0.0.1:5432/db',
    'PORT=8017',
    '# DB 接続（ローカル開発時のみ設定）',
    'DATABASE_URL=postgres://user:pass@localhost:5432/cocotte_vert',
  ].join('\n');

  assert.deepEqual(duplicateKeys(env), ['DATABASE_URL']);
});

test('重複があれば ✗ にし、後の行が採られることを伝える', () => {
  const rows = duplicateRows(['DATABASE_URL', 'PORT']);
  assert.equal(hasProblem(rows), true);
  assert.match(rows.join('\n'), /DATABASE_URL, PORT が2行以上あります/);
  assert.match(rows.join('\n'), /後の行が採られます/);
});

test('重複が無ければ何も足さない', () => {
  assert.deepEqual(duplicateKeys('A=1\nB=2\n'), []);
  assert.deepEqual(duplicateRows([]), []);
});

test('コメント・空行・値の続きはキーとして数えない', () => {
  const env = [
    '# DATABASE_URL=postgres://sample',
    '',
    'NOTE=一行目',
    '  つづき（キーではない）',
    'NOTE=二行目',
  ].join('\n');

  // コメント行の DATABASE_URL は数えない。NOTE だけが重複
  assert.deepEqual(duplicateKeys(env), ['NOTE']);
});

test('前に空白があってもキーとして数える（.env は空白を許すため）', () => {
  assert.deepEqual(duplicateKeys('  PORT=1\nPORT=2\n'), ['PORT']);
});
