import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAfterVisitJob } from '../src/jobs/afterVisit.js';
import { buildAfterVisitMessage } from '../src/line/messages/afterVisit.js';

function makeRow(id) {
  return { id, customer_id: id * 10, line_user_id: `U${id}`, customer_name: `顧客${id}` };
}

test('Flex Message に顧客名と followup postback が含まれる', () => {
  const msg = buildAfterVisitMessage({ customerName: '山田', reservationId: 42 });
  const json = JSON.stringify(msg);
  assert.match(json, /山田様/);
  assert.match(json, /action=followup&res=42&v=good/);
  assert.match(json, /action=followup&res=42&v=concern/);
});

test('dedupe_key は after_visit:res:{id}', async () => {
  const delivered = [];
  const pool = { query: async () => ({ rows: [makeRow(5)] }) };
  const lineClient = {
    deliver: async (args) => {
      delivered.push(args);
      return { status: 'sent' };
    },
  };
  const job = createAfterVisitJob({ pool, lineClient });

  const summary = await job();
  assert.equal(summary.sent, 1);
  assert.equal(delivered[0].dedupeKey, 'after_visit:res:5');
  assert.equal(delivered[0].jobType, 'after_visit');
});

test('抽出クエリが仕様の条件を含む', async () => {
  let capturedSql = '';
  const pool = {
    query: async (sql) => {
      capturedSql = sql;
      return { rows: [] };
    },
  };
  const job = createAfterVisitJob({ pool, lineClient: {} });
  await job();

  assert.match(capturedSql, /status = 'visited'/);
  assert.match(capturedSql, /CURRENT_DATE - INTERVAL '7 day'/);
  assert.match(capturedSql, /AT TIME ZONE 'Asia\/Tokyo'/, '日付比較は JST に明示変換');
  assert.match(capturedSql, /opt_out = false/, 'フォローは opt_out を除外する');
  assert.match(capturedSql, /is_blocked = false/);
  assert.match(capturedSql, /DISTINCT ON \(c\.id\)/, '同一顧客は最新1件のみ');
});

test('1件の失敗が他の対象者を止めない', async () => {
  const pool = { query: async () => ({ rows: [makeRow(1), makeRow(2)] }) };
  let calls = 0;
  const lineClient = {
    deliver: async () => {
      calls++;
      if (calls === 1) throw new Error('boom');
      return { status: 'sent' };
    },
  };
  const job = createAfterVisitJob({ pool, lineClient });

  const summary = await job();
  assert.equal(calls, 2);
  assert.equal(summary.sent, 1);
  assert.equal(summary.failed, 1);
});
