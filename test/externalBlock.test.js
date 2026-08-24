import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExternalBlocks } from '../src/reservations/externalBlock.js';

function makePool(rows = []) {
  const queries = [];
  return {
    queries,
    query: async (sql, params) => {
      queries.push({ sql, params });
      return { rows: typeof rows === 'function' ? rows(sql, params) : rows };
    },
  };
}

const row = (over = {}) => ({
  id: 1, reserved_at: '2026-09-01T05:00:00.000Z', menu: 'カット',
  status: 'confirmed', customer_name: '田中花子', staff_name: '佐藤',
  action: 'block', ...over,
});

// ---- 一覧 ----

test('閉じる作業と開け直す作業を分けて返す', async () => {
  const pool = makePool([
    row({ id: 1, action: 'block' }),
    row({ id: 2, action: 'release', status: 'cancelled' }),
    row({ id: 3, action: 'block' }),
  ]);

  const result = await createExternalBlocks({ pool }).listPending();

  assert.deepEqual(result.toBlock.map((r) => r.id), [1, 3]);
  assert.deepEqual(result.toRelease.map((r) => r.id), [2]);
});

test('外部から取り込んだ予約は対象にしない（もとから EPARK にあるため）', async () => {
  const pool = makePool([]);
  await createExternalBlocks({ pool }).listPending();
  assert.match(pool.queries[0].sql, /r\.external_id IS NULL/);
});

test('過ぎた予約は出さない（いま枠を閉じても意味がない）', async () => {
  const pool = makePool([]);
  await createExternalBlocks({ pool }).listPending();
  assert.match(pool.queries[0].sql, /r\.reserved_at > now\(\)/);
});

test('確定は未反映のものだけ、取消は反映済みのものだけを拾う', async () => {
  const pool = makePool([]);
  await createExternalBlocks({ pool }).listPending();
  const { sql } = pool.queries[0];
  assert.match(sql, /status = 'confirmed' AND r\.external_blocked_at IS NULL/);
  assert.match(sql, /status = 'cancelled' AND r\.external_blocked_at IS NOT NULL/);
});

// ---- 済み・未済の記録 ----

test('確定の予約は、済みで時刻が入り、未済で消える', async () => {
  const pool = makePool([{ id: 5, status: 'confirmed' }]);
  const blocks = createExternalBlocks({ pool });

  const done = await blocks.setDone({ id: 5, done: true, cells: ['10:00', '11:00'] });
  assert.equal(done.ok, true);
  assert.deepEqual(pool.queries[0].params, [5, true, '["10:00","11:00"]']);

  await blocks.setDone({ id: 5, done: false });
  assert.deepEqual(pool.queries[1].params, [5, false, null]);

  // 向きは SQL 側で状態から決める（画面の申告を信用しない）
  assert.match(pool.queries[0].sql, /WHEN status = 'confirmed' THEN \(CASE WHEN \$2 THEN now\(\) ELSE NULL END\)/);
});

test('取消の予約は逆向き（開け直したら記録を消す）', async () => {
  const pool = makePool([{ id: 6, status: 'cancelled' }]);
  await createExternalBlocks({ pool }).setDone({ id: 6, done: true });
  assert.match(pool.queries[0].sql, /ELSE \(CASE WHEN \$2 THEN NULL ELSE now\(\) END\)/);
});

test('外部から取り込んだ予約は動かせない', async () => {
  const pool = makePool([]);
  const result = await createExternalBlocks({ pool }).setDone({ id: 9, done: true });

  assert.deepEqual(result, { ok: false, error: 'not_found' });
  assert.match(pool.queries[0].sql, /WHERE id = \$1 AND external_id IS NULL/);
});

test('壊れた id は問い合わせずに断る', async () => {
  const pool = makePool([]);
  const blocks = createExternalBlocks({ pool });

  for (const id of [0, -1, 1.5, NaN, undefined]) {
    const result = await blocks.setDone({ id, done: true });
    assert.deepEqual(result, { ok: false, error: 'invalid_id' }, String(id));
  }
  assert.equal(pool.queries.length, 0);
});

test('done を省略したら未済として扱う（呼び出し側が明示する前提）', async () => {
  const pool = makePool([{ id: 7, status: 'confirmed' }]);
  await createExternalBlocks({ pool }).setDone({ id: 7, done: undefined });
  // 曖昧なまま「済み」にすると、やっていない作業が消える。安全側に倒す
  assert.equal(pool.queries[0].params[1], false);
});
