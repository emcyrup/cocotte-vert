import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createAdminRouter } from '../src/http/adminRoutes.js';

function makeApp({ staffRows = [], counts = { reservations: '0', shifts: '0', requests: '0' } } = {}) {
  const queries = [];
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/FROM staff s WHERE/.test(sql)) return { rows: staffRows };
      if (/SELECT \(SELECT count\(\*\) FROM reservations WHERE staff_id/.test(sql)) return { rows: [counts] };
      if (/DELETE FROM staff/.test(sql)) return { rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  const app = express();
  app.use(express.json());
  app.use('/api/admin', createAdminRouter({ pool, reservationService: {}, lineClient: {}, config: {} }));
  app.use((_err, _req, res, _next) => res.status(500).json({ error: 'internal' }));
  return { app, queries };
}

async function request(app, method, path) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } finally {
    server.close();
  }
}

test('スタッフ一覧は、担当している予約の件数も返す', async () => {
  // 画面はこの件数で削除ボタンを出すかどうかを決める。押しても断られるボタンを出さないため
  const { app, queries } = makeApp({
    staffRows: [{ id: 1, name: '佐藤', active: true, line_user_id: null, line_linked: false, reservation_count: 3 }],
  });

  const res = await request(app, 'GET', '/api/admin/staff');

  assert.equal(res.status, 200);
  assert.equal(res.body.staff[0].reservation_count, 3);
  assert.match(queries[0].sql, /count\(\*\) FROM reservations r WHERE r\.staff_id = s\.id/);
});

test('退職者を含める指定でも件数は返る', async () => {
  const { app, queries } = makeApp({ staffRows: [] });
  await request(app, 'GET', '/api/admin/staff?all=1');
  assert.equal(queries[0].params[0], '1');
  assert.match(queries[0].sql, /reservation_count/);
});

test('予約の担当として残っている人は削除できない（件数を添えて断る）', async () => {
  const { app } = makeApp({ counts: { reservations: '2', shifts: '5', requests: '1' } });

  const res = await request(app, 'DELETE', '/api/admin/staff/1');

  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: 'staff_in_use', reservations: 2 });
});

test('退職にしても削除できるようにはならない（記録を守るため）', async () => {
  // active の値に関わらず、予約に担当として残っていれば断る。
  // 画面の案内を「退職にすれば消せる」と書かないための裏付け
  const { app } = makeApp({ counts: { reservations: '1', shifts: '0', requests: '0' } });

  const res = await request(app, 'DELETE', '/api/admin/staff/1');

  assert.equal(res.status, 409);
});

test('担当している予約が無ければ削除でき、消えたものを返す', async () => {
  const { app } = makeApp({ counts: { reservations: '0', shifts: '4', requests: '2' } });

  const res = await request(app, 'DELETE', '/api/admin/staff/1');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, deleted: { shifts: 4, requests: 2 } });
});
