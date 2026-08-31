import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJobRunner, dueJobs, jstHour } from '../src/jobs/runner.js';

// 実行結果は Push せず app_settings に保存する運用のため、保存先も差し替えられるようにする
function makeSettings() {
  const store = new Map();
  return { store, settings: { get: async (k) => store.get(k) ?? null, set: async (k, v) => void store.set(k, v) } };
}

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

const quotaClient = (limit, remaining) => ({
  getQuota: async () => ({ limited: true, limit, used: limit - remaining, remaining }),
});

test('ライトプラン: 残り10%（500通）を切ると警告する', async () => {
  const { slack, notifications } = makeSlack();
  const runner = createJobRunner({ slack });

  await runner.checkQuota(quotaClient(5000, 480));
  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /残り 480 通・約10%/);
});

test('スタンダードプランでも設定変更なしで残り10%（3,000通）判定になる', async () => {
  const { slack, notifications } = makeSlack();
  const runner = createJobRunner({ slack });

  await runner.checkQuota(quotaClient(30000, 2500));
  assert.equal(notifications.length, 1, '上限に応じて閾値が自動で上がる');

  await runner.checkQuota(quotaClient(30000, 4000));
  assert.equal(notifications.length, 1, '残り13%では警告しない');
});

test('残数が十分なら警告しない', async () => {
  const { slack, notifications } = makeSlack();
  const runner = createJobRunner({ slack });

  await runner.checkQuota(quotaClient(5000, 4900));
  assert.equal(notifications.length, 0);
});

test('通数を明示した場合は割合より優先される', async () => {
  const { slack, notifications } = makeSlack();
  const runner = createJobRunner({ slack });

  // 残り800通は既定（10%=500）では警告されないが、閾値1000を明示すれば警告される
  await runner.checkQuota(quotaClient(5000, 800));
  assert.equal(notifications.length, 0);

  await runner.checkQuota(quotaClient(5000, 800), { warnRemaining: 1000 });
  assert.equal(notifications.length, 1);
});

test('無制限プラン（type=none）は警告しない', async () => {
  const { slack, notifications } = makeSlack();
  const runner = createJobRunner({ slack });
  const lineClient = { getQuota: async () => ({ limited: false, used: 100 }) };

  await runner.checkQuota(lineClient);
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

  await runner.checkQuota(lineClient);
  assert.equal(notifications.length, 0);
});

test('runAll: 結果は Push せず保存される（通数を消費しないため）', async () => {
  const { slack, notifications } = makeSlack();
  const { store, settings } = makeSettings();
  const runner = createJobRunner({ slack, settings });
  const ok = { total: 2, sent: 2, dryRun: 0, skipped: 0, failed: 0, errors: [] };
  const zero = { total: 0, sent: 0, dryRun: 0, skipped: 0, failed: 0, errors: [] };

  await runner.runAll({
    preReminder: async () => ok,
    afterVisit: async () => zero,
    dormant: async () => zero,
    birthday: async () => zero,
  });

  assert.equal(notifications.length, 0, '通数を消費する Push はしない');
  const text = store.get('last_job_summary');
  assert.ok(text, '実行結果が保存される');
  assert.match(text, /ジョブ実行結果/);
  assert.match(text, /・前々日確認: 対象 2 \/ 送信 2/);
  assert.match(text, /・来店フォロー: 対象 0/);
  assert.match(text, /・休眠フォロー: 対象 0/);
  assert.match(text, /・誕生日: 対象 0/);
});

test('runAll: 失敗詳細と通数警告も同じまとめに含まれる', async () => {
  const { slack } = makeSlack();
  const { store, settings } = makeSettings();
  const runner = createJobRunner({ slack, settings });
  const withFailure = {
    total: 3, sent: 2, dryRun: 0, skipped: 0, failed: 1,
    errors: [{ customerId: 7, message: 'LINE API error' }],
  };
  const lineClient = {
    getQuota: async () => ({ limited: true, limit: 5000, used: 4700, remaining: 300 }),
  };

  await runner.runAll({ preReminder: async () => withFailure }, { lineClient });

  const text = store.get('last_job_summary');
  assert.match(text, /⚠️ 失敗 1/);
  assert.match(text, /前々日確認: customer=7: LINE API error/);
  assert.match(text, /残り 300 通/);
});

test('runAll: 異常終了したジョブはまとめに明記され、スタックは即時に別通知される', async () => {
  const { slack, notifications } = makeSlack();
  const { store, settings } = makeSettings();
  const runner = createJobRunner({ slack, settings });
  const zero = { total: 0, sent: 0, dryRun: 0, skipped: 0, failed: 0, errors: [] };

  await runner.runAll({
    preReminder: async () => {
      throw new Error('db down');
    },
    birthday: async () => zero,
  });

  assert.equal(notifications.length, 1, '異常終了だけは即時に Push する');
  assert.match(notifications[0], /ERROR:ジョブ異常終了: preReminder:db down/);
  const text = store.get('last_job_summary');
  assert.match(text, /・前々日確認: 🚨 異常終了/);
  assert.match(text, /・誕生日: 対象 0/, '異常終了後も他ジョブは実行される');
});

test('runAll: 保存に失敗したときは結果が消えないよう Push する', async () => {
  const { slack, notifications } = makeSlack();
  const settings = {
    get: async () => null,
    set: async () => {
      throw new Error('db down');
    },
  };
  const runner = createJobRunner({ slack, settings });
  const zero = { total: 0, sent: 0, dryRun: 0, skipped: 0, failed: 0, errors: [] };

  await runner.runAll({ birthday: async () => zero });

  assert.equal(notifications.length, 1);
  assert.match(notifications[0], /ジョブ実行結果/);
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

// ---- 時刻ごとの実行判定 ----

test('dueJobs: 設定した時刻のジョブだけを選ぶ（未設定は10時）', async () => {
  const jobs = { preReminder: () => {}, birthday: () => {}, dormant: () => {} };
  const hours = { birthday: 9 };

  assert.deepEqual(Object.keys(await dueJobs(jobs, 9, { hours })), ['birthday']);
  assert.deepEqual(Object.keys(await dueJobs(jobs, 10, { hours })), ['preReminder', 'dormant']);
  assert.deepEqual(Object.keys(await dueJobs(jobs, 12, { hours })), []);
});

test('dueJobs: 判定関数を持つジョブ（追加リマインド）はそちらに聞く', async () => {
  const asked = [];
  const jobs = { custom: () => {}, birthday: () => {} };
  const jobDue = { custom: async (h) => { asked.push(h); return h === 14; } };

  assert.deepEqual(Object.keys(await dueJobs(jobs, 14, { hours: {}, jobDue })), ['custom']);
  assert.deepEqual(Object.keys(await dueJobs(jobs, 10, { hours: {}, jobDue })), ['birthday']);
  assert.deepEqual(asked, [14, 10]);
});

test('jstHour: サーバーの TZ に依存せず JST の時を返す', () => {
  // UTC 01:00 = JST 10:00
  assert.equal(jstHour(new Date('2026-08-30T01:00:00Z')), 10);
  // UTC 15:00 = JST 翌0:00
  assert.equal(jstHour(new Date('2026-08-30T15:00:00Z')), 0);
});

test('runAll(append): 同じ日の結果は上書きせず後ろへ足す', async () => {
  const { settings, store } = makeSettings();
  const { slack } = makeSlack();
  const runner = createJobRunner({ slack, settings });
  const ok = async () => ({ total: 1, sent: 1, dryRun: 0, skipped: 0, failed: 0, errors: [] });

  await runner.runAll({ birthday: ok }, { append: true });
  await runner.runAll({ dormant: ok }, { append: true });

  const saved = store.get('last_job_summary');
  assert.match(saved, /誕生日/);
  assert.match(saved, /休眠フォロー/, '2回目で1回目が消えていない');
});
