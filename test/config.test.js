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

test('スタッフ通知: line チャネルは STAFF_LINE_GROUP_ID 必須、Slack URL は不要', () => {
  const env = { ...baseEnv, STAFF_NOTIFY_CHANNEL: 'line' };
  delete env.SLACK_WEBHOOK_URL;
  assert.throws(() => loadConfig(env), /STAFF_LINE_GROUP_ID/);

  const config = loadConfig({ ...env, STAFF_LINE_GROUP_ID: 'Cgroup1' });
  assert.equal(config.staffNotifyChannel, 'line');
  assert.equal(config.staffLineGroupId, 'Cgroup1');
});

test('スタッフ通知: 不正なチャネルは拒否する', () => {
  assert.throws(() => loadConfig({ ...baseEnv, STAFF_NOTIFY_CHANNEL: 'email' }), /STAFF_NOTIFY_CHANNEL/);
});
