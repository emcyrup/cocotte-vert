import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createAdminRouter } from '../src/http/adminRoutes.js';

function makeApp({
  staffRows = [],
  counts = { reservations: '0', shifts: '0', requests: '0' },
  target = { active: true },
  deleted = 1,
} = {}) {
  const queries = [];
  const run = async (sql, params) => {
    queries.push({ sql, params });
    if (/FROM staff s WHERE/.test(sql)) return { rows: staffRows };
    if (/SELECT active FROM staff/.test(sql)) return { rows: target ? [target] : [] };
    if (/SELECT \(SELECT count\(\*\) FROM reservations WHERE staff_id/.test(sql)) return { rows: [counts] };
    if (/DELETE FROM staff/.test(sql)) return { rowCount: deleted };
    return { rows: [], rowCount: 0 };
  };
  const pool = {
    query: run,
    // 削除は「担当を外す → 消す」をまとめて行うため、トランザクションを使う
    connect: async () => ({ query: run, release: () => {} }),
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

test('在職中の人が予約の担当に入っていれば削除できない（件数を添えて断る）', async () => {
  const { app, queries } = makeApp({
    counts: { reservations: '2', shifts: '5', requests: '1' },
    target: { active: true },
  });

  const res = await request(app, 'DELETE', '/api/admin/staff/1');

  assert.equal(res.status, 409);
  assert.deepEqual(res.body, { error: 'staff_active_in_use', reservations: 2 });
  assert.equal(queries.filter((q) => /DELETE FROM staff/.test(q.sql)).length, 0);
});

test('退職者は、予約の担当に入っていても削除できる', async () => {
  const { app, queries } = makeApp({
    counts: { reservations: '3', shifts: '4', requests: '2' },
    target: { active: false },
  });

  const res = await request(app, 'DELETE', '/api/admin/staff/1');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, deleted: { shifts: 4, requests: 2, reservations: 3 } });
});

test('削除すると、予約と下書きの担当が外れて「不明」になる', async () => {
  const { app, queries } = makeApp({
    counts: { reservations: '3', shifts: '0', requests: '0' },
    target: { active: false },
  });

  await request(app, 'DELETE', '/api/admin/staff/1');

  const sqls = queries.map((q) => q.sql);
  assert.ok(sqls.some((q) => /UPDATE reservations SET staff_id = NULL/.test(q)));
  assert.ok(sqls.some((q) => /UPDATE reservation_drafts SET staff_id = NULL/.test(q)));
  // 「担当だけ外れて本人が消えない」状態を作らないよう、まとめて行う
  assert.ok(sqls.includes('BEGIN') && sqls.includes('COMMIT'));
  assert.ok(sqls.indexOf('BEGIN') < sqls.findIndex((q) => /DELETE FROM staff/.test(q)));
});

test('担当している予約が無ければ、在職中でも削除できる', async () => {
  const { app } = makeApp({ counts: { reservations: '0', shifts: '4', requests: '2' }, target: { active: true } });

  const res = await request(app, 'DELETE', '/api/admin/staff/1');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, deleted: { shifts: 4, requests: 2, reservations: 0 } });
});

test('いないスタッフの削除は 404', async () => {
  const { app, queries } = makeApp({ target: null });

  const res = await request(app, 'DELETE', '/api/admin/staff/99');

  assert.equal(res.status, 404);
  assert.equal(queries.filter((q) => /UPDATE reservations/.test(q.sql)).length, 0, '先に担当を外さない');
});

// ---- 予約の更新（状態の変更と内容の修正を兼ねる）----

function makeResvApp() {
  const calls = [];
  const app = express();
  app.use(express.json());
  app.use('/api/admin', createAdminRouter({
    pool: { query: async () => ({ rows: [], rowCount: 0 }) },
    reservationService: {
      setStatus: async (id, status) => { calls.push({ kind: 'status', id, status }); return { ok: true }; },
      updateManual: async (args) => { calls.push({ kind: 'update', ...args }); return { ok: true }; },
    },
    lineClient: {}, config: {},
  }));
  app.use((_err, _req, res, _next) => res.status(500).json({ error: 'internal' }));
  return { app, calls };
}

async function patch(app, path, body) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } finally {
    server.close();
  }
}

test('status が入っていれば、これまでどおり状態の変更', async () => {
  const { app, calls } = makeResvApp();
  const res = await patch(app, '/api/admin/reservations/7', { status: 'visited' });
  assert.equal(res.status, 200);
  assert.deepEqual(calls[0], { kind: 'status', id: 7, status: 'visited' });
});

test('status が無ければ、内容の修正として扱う', async () => {
  const { app, calls } = makeResvApp();

  const res = await patch(app, '/api/admin/reservations/7', {
    reservedAt: '2026-09-02T10:30:00+09:00', menu: 'シャンプー', staffId: '2', durationMinutes: '90',
  });

  assert.equal(res.status, 200);
  assert.deepEqual(calls[0], {
    kind: 'update', id: 7, reservedAt: '2026-09-02T10:30:00+09:00',
    menu: 'シャンプー', staffId: 2, durationMinutes: 90,
  });
});

test('担当・所要時間が空なら未設定として渡す', async () => {
  const { app, calls } = makeResvApp();
  await patch(app, '/api/admin/reservations/7', {
    reservedAt: '2026-09-02T10:30:00+09:00', staffId: '', durationMinutes: '',
  });
  assert.equal(calls[0].staffId, null);
  assert.equal(calls[0].durationMinutes, null);
});
