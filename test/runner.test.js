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

test('通数残数が閾値以下なら Slack へ警告する', async () => {
  const { slack, notifications } = makeSlack();
  const runner = createJobRunner({ slack });
  const lineClient = {
    getQuota: async () => ({ limited: true, limit: 5000, used: 4800, remaining: 200 }),
  };

  await runner.checkQuota(lineClient, 300);
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /残り 200 通/);
});

test('残数が十分なら警告しない', async () => {
  const { slack, notifications } = makeSlack();
  const runner = createJobRunner({ slack });
  const lineClient = {
    getQuota: async () => ({ limited: true, limit: 5000, used: 100, remaining: 4900 }),
  };

  await runner.checkQuota(lineClient, 300);
  assert.equal(notifications.length, 0);
});

test('無制限プラン（type=none）は警告しない', async () => {
  const { slack, notifications } = makeSlack();
  const runner = createJobRunner({ slack });
  const lineClient = { getQuota: async () => ({ limited: false, used: 100 }) };

  await runner.checkQuota(lineClient, 300);
  assert.equal(notifications.length, 0);
});

test('残数確認の失敗はジョブを止めず警告も出さない', async () => {
  const { slack, notifications } = makeSlack();
  const runner = createJobRunner({ slack });
  const lineClient = {
    getQuota: async () => {
      throw new Error('api down');
    },
  };

  await runner.checkQuota(lineClient, 300);
  assert.equal(notifications.length, 0);
});

test('runAll: 全ジョブの結果が1つのまとめメッセージで通知される', async () => {
  const { slack, notifications } = makeSlack();
  const runner = createJobRunner({ slack });
  const ok = { total: 2, sent: 2, dryRun: 0, skipped: 0, failed: 0, errors: [] };
  const zero = { total: 0, sent: 0, dryRun: 0, skipped: 0, failed: 0, errors: [] };

  await runner.runAll({
    preReminder: async () => ok,
    afterVisit: async () => zero,
    dormant: async () => zero,
    birthday: async () => zero,
  });

  assert.equal(notifications.length, 1, '通知は1通だけ');
  const text = notifications[0];
  assert.match(text, /本日のジョブ実行結果/);
  assert.match(text, /・前々日確認: 対象 2 \/ 送信 2/);
  assert.match(text, /・来店フォロー: 対象 0/);
  assert.match(text, /・休眠フォロー: 対象 0/);
  assert.match(text, /・誕生日: 対象 0/);
});

test('runAll: 失敗詳細と通数警告も同じメッセージに含まれる', async () => {
  const { slack, notifications } = makeSlack();
  const runner = createJobRunner({ slack });
  const withFailure = {
    total: 3, sent: 2, dryRun: 0, skipped: 0, failed: 1,
    errors: [{ customerId: 7, message: 'LINE API error' }],
  };
  const lineClient = {
    getQuota: async () => ({ limited: true, limit: 5000, used: 4700, remaining: 300 }),
  };

  await runner.runAll({ preReminder: async () => withFailure }, { lineClient, quotaWarnRemaining: 500 });

  assert.equal(notifications.length, 1);
  const text = notifications[0];
  assert.match(text, /⚠️ 失敗 1/);
  assert.match(text, /前々日確認: customer=7: LINE API error/);
  assert.match(text, /残り 300 通/);
});

test('runAll: 異常終了したジョブはまとめに明記され、スタックは即時に別通知される', async () => {
  const { slack, notifications } = makeSlack();
  const runner = createJobRunner({ slack });
  const zero = { total: 0, sent: 0, dryRun: 0, skipped: 0, failed: 0, errors: [] };

  await runner.runAll({
    preReminder: async () => {
      throw new Error('db down');
    },
    birthday: async () => zero,
  });

  assert.equal(notifications.length, 2, '異常終了の詳細＋まとめの2通');
  assert.match(notifications[0], /ERROR:ジョブ異常終了: preReminder:db down/);
  assert.match(notifications[1], /・前々日確認: 🚨 異常終了/);
  assert.match(notifications[1], /・誕生日: 対象 0/, '異常終了後も他ジョブは実行される');
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
