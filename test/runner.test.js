import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJobRunner } from '../src/jobs/runner.js';

function makeSlack() {
  const notifications = [];
  return {
    notifications,
    slack: {
      notify: async (text) => notifications.push(text),
      notifyError: async (ctx, err) => notifications.push(`ERROR:${ctx}:${err.message}`),
    },
  };
}

test('正常終了でサマリが Slack へ送られる', async () => {
  const { slack, notifications } = makeSlack();
  const runner = createJobRunner({ slack });

  const summary = await runner.runJob('preReminder', async () => ({
    total: 3, sent: 2, dryRun: 0, skipped: 1, failed: 0, errors: [],
  }));

  assert.equal(summary.sent, 2);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /preReminder/);
  assert.match(notifications[0], /対象 3 \/ 送信 2/);
});

test('失敗があると詳細通知が追加で送られる（顧客は内部 id のみ）', async () => {
  const { slack, notifications } = makeSlack();
  const runner = createJobRunner({ slack });

  await runner.runJob('preReminder', async () => ({
    total: 2, sent: 1, dryRun: 0, skipped: 0, failed: 1,
    errors: [{ customerId: 7, message: 'LINE API error' }],
  }));

  assert.equal(notifications.length, 2);
  assert.match(notifications[1], /customer=7/);
});

test('ジョブ全体の異常終了は notifyError され null が返る', async () => {
  const { slack, notifications } = makeSlack();
  const runner = createJobRunner({ slack });

  const result = await runner.runJob('preReminder', async () => {
    throw new Error('db down');
  });

  assert.equal(result, null);
  assert.match(notifications[0], /ERROR:ジョブ異常終了: preReminder:db down/);
});
