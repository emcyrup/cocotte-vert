import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';

const baseEnv = {
  DATABASE_URL: 'postgres://localhost/test',
  LINE_CHANNEL_ACCESS_TOKEN: 'token',
  LINE_CHANNEL_SECRET: 'secret',
  SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/x',
};

test('必須変数が揃っていれば読み込める', () => {
  const config = loadConfig({ ...baseEnv });
  assert.equal(config.databaseUrl, baseEnv.DATABASE_URL);
});

test('必須変数が欠けていると起動時に落ちる', () => {
  const env = { ...baseEnv };
  delete env.LINE_CHANNEL_SECRET;
  assert.throws(() => loadConfig(env), /LINE_CHANNEL_SECRET/);
});

test('SEND_MODE 未指定時のデフォルトは dry_run', () => {
  const config = loadConfig({ ...baseEnv });
  assert.equal(config.sendMode, 'dry_run');
});

test('通数警告は既定で上限の10%判定（通数固定は任意）', () => {
  const config = loadConfig({ ...baseEnv });
  assert.equal(config.quotaWarnRatio, 0.1);
  assert.equal(config.quotaWarnRemaining, null, '未指定なら割合判定を使う');

  const fixed = loadConfig({ ...baseEnv, QUOTA_WARN_REMAINING: '800' });
  assert.equal(fixed.quotaWarnRemaining, 800);
  assert.equal(loadConfig({ ...baseEnv, QUOTA_WARN_RATIO: '0.2' }).quotaWarnRatio, 0.2);
});

test('不正な SEND_MODE は拒否する', () => {
  assert.throws(() => loadConfig({ ...baseEnv, SEND_MODE: 'production' }), /SEND_MODE/);
});

test('SEND_MODE=test は TEST_LINE_USER_ID がないと拒否する', () => {
  assert.throws(() => loadConfig({ ...baseEnv, SEND_MODE: 'test' }), /TEST_LINE_USER_ID/);
  const config = loadConfig({ ...baseEnv, SEND_MODE: 'test', TEST_LINE_USER_ID: 'Utest' });
  assert.equal(config.sendMode, 'test');
});

test('TZ が Asia/Tokyo 以外なら拒否する', () => {
  assert.throws(() => loadConfig({ ...baseEnv, TZ: 'UTC' }), /Asia\/Tokyo/);
});

test('スタッフ通知: デフォルト slack は SLACK_WEBHOOK_URL 必須', () => {
  const env = { ...baseEnv };
  delete env.SLACK_WEBHOOK_URL;
  assert.throws(() => loadConfig(env), /SLACK_WEBHOOK_URL/);
});

test('スタッフ通知: line チャネルは Slack URL 不要、グループ ID は任意（参加時に自動設定）', () => {
  const env = { ...baseEnv, STAFF_NOTIFY_CHANNEL: 'line' };
  delete env.SLACK_WEBHOOK_URL;

  const config = loadConfig(env);
  assert.equal(config.staffNotifyChannel, 'line');
  assert.equal(config.staffLineGroupId, null);

  const withOverride = loadConfig({ ...env, STAFF_LINE_GROUP_ID: 'Cgroup1' });
  assert.equal(withOverride.staffLineGroupId, 'Cgroup1');
});

test('スタッフ通知: 不正なチャネルは拒否する', () => {
  assert.throws(() => loadConfig({ ...baseEnv, STAFF_NOTIFY_CHANNEL: 'email' }), /STAFF_NOTIFY_CHANNEL/);
});

test('配信の日数は既定値があり、設定で変えられる', () => {
  const c = loadConfig(baseEnv);
  assert.equal(c.preReminderDaysBefore, 2);
  assert.equal(c.afterVisitDaysAfter, 7);
  assert.equal(c.dormantDays, 90);

  const custom = loadConfig({
    ...baseEnv,
    PRE_REMINDER_DAYS_BEFORE: '3',
    AFTER_VISIT_DAYS_AFTER: '14',
    DORMANT_DAYS: '180',
  });
  assert.equal(custom.preReminderDaysBefore, 3);
  assert.equal(custom.afterVisitDaysAfter, 14);
  assert.equal(custom.dormantDays, 180);
});

test('配信の日数の書き間違いは起動時に落とす', () => {
  assert.throws(() => loadConfig({ ...baseEnv, DORMANT_DAYS: '0' }), /DORMANT_DAYS/);
  assert.throws(() => loadConfig({ ...baseEnv, DORMANT_DAYS: '90日' }), /DORMANT_DAYS/);
  assert.throws(() => loadConfig({ ...baseEnv, AFTER_VISIT_DAYS_AFTER: '1.5' }), /AFTER_VISIT_DAYS_AFTER/);
});

test('EPARK の自動操作は既定で off（明示しない限り相手の画面を触らない）', () => {
  assert.equal(loadConfig({ ...baseEnv }).epark.mode, 'off');
});

test('EPARK を動かすならログイン情報が要る', () => {
  assert.throws(() => loadConfig({ ...baseEnv, EPARK_MODE: 'live' }), /EPARK_USER/);
  assert.throws(() => loadConfig({ ...baseEnv, EPARK_MODE: 'dry_run' }), /EPARK_USER/);
  const config = loadConfig({ ...baseEnv, EPARK_MODE: 'live', EPARK_USER: 'u', EPARK_PASSWORD: 'p' });
  assert.equal(config.epark.mode, 'live');
});

test('不正な EPARK_MODE は拒否する', () => {
  assert.throws(() => loadConfig({ ...baseEnv, EPARK_MODE: 'test' }), /EPARK_MODE/);
});

test('即時反映は既定で無効。有効にするなら宛先とトークンが揃っていること', () => {
  assert.equal(loadConfig(baseEnv).epark.trigger.enabled, false);

  // 揃わないまま有効にすると、起こせていないことに気付けないまま遅れ続ける
  assert.throws(() => loadConfig({ ...baseEnv, EPARK_TRIGGER: 'on' }), /GITHUB_REPO/);
  assert.throws(
    () => loadConfig({ ...baseEnv, EPARK_TRIGGER: 'on', GITHUB_REPO: 'owner/repo' }),
    /GITHUB_ACTIONS_TOKEN/
  );
  // owner/repo 以外を渡すと、存在しない宛先を叩き続けることになる
  assert.throws(
    () => loadConfig({ ...baseEnv, EPARK_TRIGGER: 'on', GITHUB_REPO: 'https://github.com/o/r', GITHUB_ACTIONS_TOKEN: 't' }),
    /owner\/repo/
  );

  const on = loadConfig({
    ...baseEnv, EPARK_TRIGGER: 'on', GITHUB_REPO: 'owner/repo', GITHUB_ACTIONS_TOKEN: 't',
  }).epark.trigger;
  assert.equal(on.enabled, true);
  assert.equal(on.workflow, 'epark-sync.yml', '既定の宛先');
  assert.equal(on.ref, 'main');
});

// 実物でこれに詰まった。書き方が少し違うだけで**黙って off に落ち**、
// 外から確かめる手立ても無かった
test('EPARK_TRIGGER の書き方の揺れを許し、読めない値は断る', () => {
  const withKeys = (v) => loadConfig({
    ...baseEnv, EPARK_TRIGGER: v, GITHUB_REPO: 'owner/repo', GITHUB_ACTIONS_TOKEN: 't',
  }).epark.trigger.enabled;

  for (const v of ['on', 'ON', ' On ', 'true', '1', 'yes']) {
    assert.equal(withKeys(v), true, `${JSON.stringify(v)} は有効として読む`);
  }
  for (const v of ['off', 'OFF', 'false', '0', 'no', '']) {
    assert.equal(withKeys(v), false, `${JSON.stringify(v)} は無効として読む`);
  }
  // どちらとも読めない値を黙って off にすると、動かない理由に気付けない
  assert.throws(() => withKeys('onn'), /EPARK_TRIGGER/);
  assert.throws(() => withKeys('有効'), /EPARK_TRIGGER/);
});

test('仮受付にお名前を載せるのが既定。EPARK_DETAILS=off で無名に戻せる', () => {
  assert.equal(loadConfig({ ...baseEnv }).epark.details, true);
  assert.equal(loadConfig({ ...baseEnv, EPARK_DETAILS: 'off' }).epark.details, false);
  assert.equal(loadConfig({ ...baseEnv, EPARK_DETAILS: 'on' }).epark.details, true);
});

/** 投げられた例外を取り出す（メッセージの中身まで確かめたいとき） */
function catchError(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('例外が投げられませんでした');
}

// ---- DATABASE_URL の形 ----
// 壊れていると pg が "Invalid URL" とだけ言って落ちる。サーバーに入らず原因が分かるようにする

test('データベース名が抜けていると、そう言って落ちる', () => {
  // 本番で実際に詰まったところ。名前が決まるまで空になりやすい
  assert.throws(
    () => loadConfig({ ...baseEnv, DATABASE_URL: 'postgres://user:pw@db.example:5432/' }),
    /データベース名がありません/
  );
});

test('ホスト名が抜けていてもそう言う', () => {
  assert.throws(
    () => loadConfig({ ...baseEnv, DATABASE_URL: 'postgres://user:pw@:5432/mydb' }),
    /形が正しくありません/
  );
});

test('ユーザー名の省略は認める（OS のユーザーで繋ぐ書き方）', () => {
  const url = 'postgres://db.example:5432/mydb';
  assert.equal(loadConfig({ ...baseEnv, DATABASE_URL: url }).databaseUrl, url);
});

test('URL として読めない値は、記号の可能性まで案内する', () => {
  // パスワードに @ や / が入っていると壊れる。実際に起きやすい
  const err = catchError(() => loadConfig({ ...baseEnv, DATABASE_URL: 'これはURLではない' }));
  assert.match(err.message, /形が正しくありません/);
  assert.match(err.message, /URL エンコード/);
});

test('postgres 以外のプロトコルは断る', () => {
  assert.throws(
    () => loadConfig({ ...baseEnv, DATABASE_URL: 'mysql://user:pw@db.example:3306/mydb' }),
    /postgres:\/\/ で始めてください/
  );
});

test('エラーに DATABASE_URL の中身を出さない（パスワードが入るため）', () => {
  const secret = 'himitsunoaikotoba';
  const err = catchError(() =>
    loadConfig({ ...baseEnv, DATABASE_URL: `postgres://user:${secret}@db.example:5432/` })
  );
  assert.match(err.message, /データベース名がありません/);
  assert.doesNotMatch(err.message, new RegExp(secret));
});

test('正しい形なら通る（postgresql:// も可）', () => {
  for (const url of [
    'postgres://user:pw@db.example:5432/mydb',
    'postgresql://user:pw@127.0.0.1:5432/postgres',
    'postgres://user@localhost/mydb',
  ]) {
    assert.equal(loadConfig({ ...baseEnv, DATABASE_URL: url }).databaseUrl, url, url);
  }
});
