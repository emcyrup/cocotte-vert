import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createAdminImportRouter, sanitizeMapping } from '../src/http/adminImportRoutes.js';
import { DEFAULT_MAPPING } from '../src/import/csv.js';

const HEADER = '予約番号,氏名,電話番号,予約日,予約時間,メニュー,担当者,ステータス';
const CSV = [
  HEADER,
  'R001,山田 花子,090-1234-5678,2026/08/01,14:00,カット,佐藤,予約確定',
  'R002,田中 太郎,080-0000-1111,2026/08/02,11:00,シャンプー,,来店済み',
  ',名無し,090-9999-9999,2026/08/03,10:00,,,予約確定',
].join('\n');

function makeApp({ upsert = async () => ({ ok: true, created: true, reservationId: 1 }) } = {}) {
  const stored = {};
  const notices = [];
  const calls = [];
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/import', createAdminImportRouter({
    reservationService: {
      upsertExternal: async (args) => { calls.push(args); return upsert(args); },
    },
    settings: {
      get: async (k) => stored[k] ?? null,
      set: async (k, v) => { stored[k] = v; },
    },
    slack: { notify: async (t) => notices.push(t) },
  }));
  // ルーターが next(err) したときに 500 で返す（本番の共通ハンドラと同じ扱い）
  app.use((_err, _req, res, _next) => res.status(500).json({ error: 'internal' }));
  return { app, stored, notices, calls };
}

/** テスト用の簡易クライアント。サーバを立てて実際に HTTP で叩く */
async function request(app, method, path, body) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } finally {
    server.close();
  }
}

test('保存前は既定の対応づけと、画面が組み立てる材料を返す', async () => {
  const { app } = makeApp();
  const res = await request(app, 'GET', '/import/mapping');

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.mapping, DEFAULT_MAPPING);
  assert.ok(res.body.fields.some((f) => f.key === 'external_id' && f.required));
  assert.deepEqual(res.body.statusValues, ['confirmed', 'visited', 'cancelled', 'no_show']);
});

test('対応づけを保存すると、次から取り込みに使われる', async () => {
  const { app, stored } = makeApp();
  const mapping = {
    encoding: 'utf-8',
    externalIdPrefix: 'ep-',
    columns: { external_id: '予約番号', customer_name: '氏名', phone: '電話番号', reserved_date: '予約日', reserved_time: '予約時間' },
    statusMap: { 予約確定: 'confirmed' },
    defaultStatus: 'confirmed',
  };

  const saved = await request(app, 'PUT', '/import/mapping', { mapping });
  assert.equal(saved.status, 200);
  assert.ok(stored.import_mapping, 'DB に残す（上流が変わっても画面から直せるように）');

  // マッピングを送らなくても、保存済みの内容で読み取る
  const preview = await request(app, 'POST', '/import/preview', { csv: CSV });
  assert.equal(preview.body.mapping.externalIdPrefix, 'ep-');
  assert.equal(preview.body.sample[0].external_id, 'ep-R001');
});

test('知らない項目・おかしな状態値は受け付けない', () => {
  const mapping = sanitizeMapping({
    encoding: 'euc-jp',
    externalIdPrefix: 123,
    columns: { external_id: '予約番号', 悪意のある項目: 'x', customer_name: '  ', phone: '電話' },
    statusMap: { 確定: 'confirmed', 謎: 'なにか' },
    defaultStatus: 'なにか',
  });

  assert.equal(mapping.encoding, 'shift_jis', '知らない文字コードは既定に戻す');
  assert.equal(mapping.externalIdPrefix, '');
  assert.deepEqual(Object.keys(mapping.columns), ['external_id', 'phone'], '空白だけの指定も落とす');
  assert.deepEqual(mapping.statusMap, { 確定: 'confirmed' });
  assert.equal(mapping.defaultStatus, 'confirmed');
});

test('下見では、取り込める件数と取り込めない行が分かる', async () => {
  const { app, calls } = makeApp();
  const res = await request(app, 'POST', '/import/preview', { csv: CSV });

  assert.equal(res.body.total, 3);
  assert.equal(res.body.ready, 2);
  assert.deepEqual(res.body.problems, [{ line: 4, reason: '予約番号がありません' }]);
  assert.equal(res.body.header[0], '予約番号');
  assert.equal(res.body.sample.length, 2);
  assert.equal(calls.length, 0, '下見では1件も書き込まない');
});

test('取り込むと、通った行だけが予約になる', async () => {
  const { app, calls } = makeApp();
  const res = await request(app, 'POST', '/import/reservations', { csv: CSV });

  assert.deepEqual(res.body.summary, { total: 2, created: 2, updated: 0, failed: 0, skipped: 1 });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {
    externalId: 'epark-R001',
    customerName: '山田 花子',
    phone: '090-1234-5678',
    birthday: undefined,
    menu: 'カット',
    staffName: '佐藤',
    reservedAt: '2026-08-01T14:00:00+09:00',
    status: 'confirmed',
  });
  assert.equal(calls[1].status, 'visited');
});

test('1件が失敗しても残りは取り込み、失敗を返して Slack にも出す', async () => {
  const { app, notices } = makeApp({
    upsert: async ({ externalId }) => {
      if (externalId === 'epark-R002') throw new Error('DB down');
      return { ok: true, created: false, reservationId: 5 };
    },
  });

  const res = await request(app, 'POST', '/import/reservations', { csv: CSV });

  assert.deepEqual(res.body.summary, { total: 2, created: 0, updated: 1, failed: 1, skipped: 1 });
  assert.equal(res.body.failures[0].external_id, 'epark-R002');
  assert.equal(notices.length, 1, '画面を閉じたあとでも気付けるよう通知に残す');
});

test('CSV が無い・1件も取り込めないときは書き込まない', async () => {
  const { app, calls } = makeApp();

  const empty = await request(app, 'POST', '/import/reservations', { csv: '   ' });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error, 'csv_required');

  const allBad = await request(app, 'POST', '/import/reservations', {
    csv: [HEADER, ',,,,,,,'].join('\n'),
  });
  assert.equal(allBad.status, 400);
  assert.equal(allBad.body.error, 'no_rows');
  assert.equal(calls.length, 0);
});

test('保存済みの対応づけが壊れていても、既定に戻して止まらない', async () => {
  const { app } = makeApp();
  await request(app, 'PUT', '/import/mapping', { mapping: DEFAULT_MAPPING });
  // 手で書き換えられた等で JSON として読めなくなった状態を作る
  const broken = makeApp();
  broken.stored.import_mapping = '{壊れている';

  const res = await request(broken.app, 'POST', '/import/preview', { csv: CSV });
  assert.equal(res.status, 200);
  assert.equal(res.body.ready, 2);
});
