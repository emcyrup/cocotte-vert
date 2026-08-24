import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createAdminRouter } from '../src/http/adminRoutes.js';

function makeApp(externalBlocks) {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', createAdminRouter({
    pool: { query: async () => ({ rows: [] }) },
    reservationService: {}, lineClient: {}, config: {}, externalBlocks,
  }));
  app.use((_err, _req, res, _next) => res.status(500).json({ error: 'internal' }));
  return app;
}

async function request(app, method, path, body) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } finally {
    server.close();
  }
}

test('未反映の一覧を、閉じる作業と開け直す作業に分けて返す', async () => {
  const app = makeApp({
    listPending: async () => ({ toBlock: [{ id: 1 }], toRelease: [{ id: 2 }] }),
    setDone: async () => ({ ok: true }),
  });

  const res = await request(app, 'GET', '/api/admin/external-blocks');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { toBlock: [{ id: 1 }], toRelease: [{ id: 2 }] });
});

test('未反映の仕組みが無い環境でも一覧は空で返す（画面を壊さない）', async () => {
  const res = await request(makeApp(null), 'GET', '/api/admin/external-blocks');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { toBlock: [], toRelease: [] });
});

test('チェックを付けると済みとして記録する', async () => {
  const calls = [];
  const app = makeApp({
    listPending: async () => ({ toBlock: [], toRelease: [] }),
    setDone: async (args) => { calls.push(args); return { ok: true, reservation: { id: 5 } }; },
  });

  const res = await request(app, 'PATCH', '/api/admin/external-blocks/5', { done: true });

  assert.equal(res.status, 200);
  assert.deepEqual(calls, [{ id: 5, done: true, cells: null }]);
});

test('チェックを外すと未済へ戻す', async () => {
  const calls = [];
  const app = makeApp({
    listPending: async () => ({ toBlock: [], toRelease: [] }),
    setDone: async (args) => { calls.push(args); return { ok: true }; },
  });

  await request(app, 'PATCH', '/api/admin/external-blocks/5', { done: false });

  assert.deepEqual(calls, [{ id: 5, done: false, cells: null }]);
});

test('対象が無ければ 404、値がおかしければ 400', async () => {
  const app = makeApp({
    listPending: async () => ({ toBlock: [], toRelease: [] }),
    setDone: async ({ id }) => (id === 99
      ? { ok: false, error: 'not_found' }
      : { ok: false, error: 'invalid_id' }),
  });

  assert.equal((await request(app, 'PATCH', '/api/admin/external-blocks/99', { done: true })).status, 404);
  assert.equal((await request(app, 'PATCH', '/api/admin/external-blocks/1', { done: true })).status, 400);
});

// ---- 自動化（GitHub Actions）から使うとき ----

test('fields=sync では、お客様の氏名を返さない', async () => {
  // 一覧は外（GitHub Actions）へ出ていく。要らない個人情報は渡さない
  const row = {
    id: 1, reserved_at: '2026-09-01T01:00:00.000Z', menu: 'カット', status: 'confirmed',
    duration_minutes: 60, external_blocked_cells: ['10:00'], action: 'block',
    customer_name: '田中花子', staff_name: '佐藤',
  };
  const app = makeApp({
    listPending: async () => ({ toBlock: [row], toRelease: [] }),
    setDone: async () => ({ ok: true }),
  });

  const res = await request(app, 'GET', '/api/admin/external-blocks?fields=sync');

  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body.toBlock[0]).sort(), [
    'action', 'duration_minutes', 'external_blocked_cells', 'id', 'menu', 'reserved_at', 'status',
  ]);
  assert.doesNotMatch(JSON.stringify(res.body), /田中花子|佐藤/);
});

test('画面向け（既定）では、これまでどおり氏名も返す', async () => {
  const app = makeApp({
    listPending: async () => ({ toBlock: [{ id: 1, customer_name: '田中花子' }], toRelease: [] }),
    setDone: async () => ({ ok: true }),
  });
  const res = await request(app, 'GET', '/api/admin/external-blocks');
  assert.equal(res.body.toBlock[0].customer_name, '田中花子');
});

test('自動化が閉じた枠を受け取って記録する', async () => {
  const calls = [];
  const app = makeApp({
    listPending: async () => ({ toBlock: [], toRelease: [] }),
    setDone: async (args) => { calls.push(args); return { ok: true }; },
  });

  await request(app, 'PATCH', '/api/admin/external-blocks/5', { done: true, cells: ['10:00'] });

  assert.deepEqual(calls, [{ id: 5, done: true, cells: ['10:00'] }]);
});

test('画面のチェックからは枠が来ない（手作業ではどこを触ったか分からない）', async () => {
  const calls = [];
  const app = makeApp({
    listPending: async () => ({ toBlock: [], toRelease: [] }),
    setDone: async (args) => { calls.push(args); return { ok: true }; },
  });

  await request(app, 'PATCH', '/api/admin/external-blocks/5', { done: true });

  assert.deepEqual(calls, [{ id: 5, done: true, cells: null }]);
});
