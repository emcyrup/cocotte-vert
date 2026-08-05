import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDormantJob } from '../src/jobs/dormant.js';
import { buildDormantMessage } from '../src/line/messages/dormant.js';

test('メッセージに配信停止導線（opt_out postback）が必ず入る', () => {
  const msg = buildDormantMessage({ customerName: '山田' });
  const json = JSON.stringify(msg);
  assert.match(json, /山田様/);
  assert.match(json, /action=opt_out/);
  assert.match(json, /不要な方はこちら/);
});

test('抽出クエリが仕様の条件を含み、日次上限がパラメータで渡る', async () => {
  let captured = null;
  const pool = {
    query: async (sql, params) => {
      captured = { sql, params };
      return { rows: [] };
    },
  };
  const job = createDormantJob({ pool, lineClient: {}, dailyLimit: 25 });
  await job();

  assert.match(captured.sql, /last_visit_at <= \(now\(\) AT TIME ZONE 'Asia\/Tokyo'\)::date - INTERVAL '90 day'/, '= ではなく <= で取り漏れを防ぐ。基準日は JST 明示');
  assert.match(captured.sql, /opt_out = false/);
  assert.match(captured.sql, /is_blocked = false/);
  assert.match(captured.sql, /NOT EXISTS[\s\S]*status IN \('confirmed', 'requested'\)/, '未来の予約（確定・承認待ち）がある顧客は除外');
  assert.match(captured.sql, /NOT EXISTS[\s\S]*job_type = 'dormant'[\s\S]*90 day/, '90日以内に送信済みの顧客は除外');
  assert.match(captured.sql, /LIMIT \$1/);
  assert.deepEqual(captured.params, [25]);
});

test('dedupe_key は dormant:cust:{id}:{YYYY-MM-DD}', async () => {
  const delivered = [];
  const pool = {
    query: async () => ({
      rows: [{ id: 7, line_user_id: 'U7', name: '山田', last_visit_at: '2026-03-01' }],
    }),
  };
  const lineClient = {
    deliver: async (args) => {
      delivered.push(args);
      return { status: 'sent' };
    },
  };
  const job = createDormantJob({ pool, lineClient });

  await job();
  assert.match(delivered[0].dedupeKey, /^dormant:cust:7:\d{4}-\d{2}-\d{2}$/);
  assert.equal(delivered[0].jobType, 'dormant');
});
