import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReservationDrafts } from '../src/reservations/draftService.js';

function makePool(handlers = []) {
  const queries = [];
  return {
    queries,
    query: async (sql, params) => {
      queries.push({ sql, params });
      for (const [re, result] of handlers) {
        if (re.test(sql)) return typeof result === 'function' ? result(params) : result;
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function makeFakes(handlers, createManual = async () => ({ ok: true, reservationId: 42 })) {
  const manual = [];
  return {
    pool: makePool(handlers),
    manual,
    reservationService: {
      createManual: async (args) => { manual.push(args); return createManual(args); },
    },
  };
}

const SOURCE = { type: 'group', id: 'G1' };
const draftRow = (over = {}) => ({
  id: '7', customer_id: '3', customer_name: '田中花子', new_customer_name: null,
  new_customer_phone: null, staff_id: '1', staff_name: '佐藤', menu: 'カット',
  reserved_at: '2026-08-20T05:00:00.000Z', duration_minutes: 90,
  status: 'pending', reservation_id: null, fresh: true, ...over,
});

// ---- 顧客の突合 ----

test('電話番号が一致すれば、それを本人として扱う', async () => {
  const f = makeFakes([[/WHERE phone_norm = \$1/, { rows: [{ id: 3, name: '田中花子' }] }]]);
  const drafts = createReservationDrafts(f);

  const result = await drafts.findCustomers({ name: '別の名前', phone: '090-1111-2222' });

  assert.equal(result.by, 'phone');
  assert.equal(result.matches.length, 1);
  assert.equal(f.pool.queries[0].params[0], '09011112222', 'ハイフンを除いて突合する');
  assert.equal(f.pool.queries.length, 1, '一致したら名前では探さない');
});

test('名前は空白の入れ方が違っても突き合わせる', async () => {
  const f = makeFakes([[/replace\(replace\(name/, { rows: [{ id: 3, name: '田中 花子' }] }]]);
  const drafts = createReservationDrafts(f);

  const result = await drafts.findCustomers({ name: '田中花子', phone: null });

  assert.equal(result.by, 'name');
  assert.match(f.pool.queries[0].sql, /replace\(replace\(name, ' ', ''\), '　', ''\)/);
});

test('完全一致がないときだけ、部分一致まで広げる', async () => {
  const f = makeFakes([[/ILIKE/, { rows: [{ id: 3, name: '田中花子' }, { id: 4, name: '田中太郎' }] }]]);
  const drafts = createReservationDrafts(f);

  const result = await drafts.findCustomers({ name: '田中', phone: null });

  assert.equal(result.by, 'partial');
  assert.equal(result.matches.length, 2);
});

test('誰も当たらなければ none を返す', async () => {
  const drafts = createReservationDrafts(makeFakes([]));
  assert.deepEqual(await drafts.findCustomers({ name: '誰か', phone: null }), {
    matches: [], by: 'none', phoneNorm: null,
  });
});

test('同名のスタッフが複数いるときは担当を決めない', async () => {
  const f = makeFakes([[/FROM staff/, { rows: [{ id: 1, name: '佐藤' }, { id: 5, name: '佐藤' }] }]]);
  const drafts = createReservationDrafts(f);
  assert.equal(await drafts.findStaffByName('佐藤'), null);
  assert.equal(await drafts.findStaffByName(null), null, '未指定なら問い合わせない');
});

// ---- 下書き ----

test('下書きは JST の日時として保存する', async () => {
  const f = makeFakes([[/INSERT INTO reservation_drafts/, { rows: [{ id: '7' }] }]]);
  const drafts = createReservationDrafts(f);

  await drafts.create({
    source: SOURCE,
    entry: { date: '2026-08-20', time: '14:00', menu: 'カット', durationMinutes: null, rawText: '原文' },
    customerId: 3,
    staffId: 1,
  });

  const { params } = f.pool.queries[0];
  assert.deepEqual(params.slice(0, 3), ['group', 'G1', 3]);
  assert.equal(params[7], '2026-08-20T14:00:00+09:00', 'JST であることを明示して渡す');
  assert.equal(params[9], '原文', '原文を必ず残す');
});

test('下書きの取得・更新は必ず送られてきた場所で絞る', async () => {
  const f = makeFakes([
    [/FROM reservation_drafts d/, { rows: [draftRow()] }],
    [/UPDATE reservation_drafts SET/, { rows: [{ id: '7' }] }],
  ]);
  const drafts = createReservationDrafts(f);

  await drafts.get({ draftId: 7, source: SOURCE });
  await drafts.pickCustomer({ draftId: 7, source: SOURCE, customerId: 3 });
  await drafts.cancel({ draftId: 7, source: SOURCE });

  for (const q of f.pool.queries) {
    assert.match(q.sql, /source_type = \$2 AND (d\.)?source_id = \$3/, q.sql.slice(0, 60));
    assert.deepEqual(q.params.slice(1, 3), ['group', 'G1']);
  }
});

test('id は数値にそろえる（BIGINT は文字列で返るため）', async () => {
  const f = makeFakes([[/FROM reservation_drafts d/, { rows: [draftRow()] }]]);
  const drafts = createReservationDrafts(f);

  const draft = await drafts.get({ draftId: 7, source: SOURCE });

  assert.equal(draft.customer_id, 3);
  assert.equal(draft.staff_id, 1);
});

test('決着済みの下書きは動かさない', async () => {
  const f = makeFakes([[/UPDATE reservation_drafts SET/, { rows: [] }]]);
  const drafts = createReservationDrafts(f);
  assert.deepEqual(await drafts.cancel({ draftId: 7, source: SOURCE }), { ok: false, error: 'not_found' });
});

// ---- 本予約にする ----

test('登録すると予約が作られ、下書きに予約番号が残る', async () => {
  const f = makeFakes([
    [/FROM reservation_drafts d/, { rows: [draftRow()] }],
    [/UPDATE reservation_drafts SET status = 'registered'/, { rows: [{ id: '7' }] }],
  ]);
  const drafts = createReservationDrafts(f);

  const result = await drafts.register({ draftId: 7, source: SOURCE });

  assert.equal(result.ok, true);
  assert.equal(result.reservationId, 42);
  assert.deepEqual(f.manual[0], {
    customerId: 3,
    reservedAt: '2026-08-20T05:00:00.000Z',
    menu: 'カット',
    staffId: 1,
    durationMinutes: 90,
  });
  assert.ok(
    f.pool.queries.some((q) => /SET reservation_id = \$2/.test(q.sql)),
    'あとから追えるよう予約番号を下書きに残す'
  );
});

test('先に下書きを押さえてから予約を作る（二重押しで2件入らない）', async () => {
  const f = makeFakes([
    [/FROM reservation_drafts d/, { rows: [draftRow()] }],
    // 別の誰かが先に押していて、UPDATE が1件も取れなかった場合
    [/UPDATE reservation_drafts SET status = 'registered'/, { rows: [] }],
  ]);
  const drafts = createReservationDrafts(f);

  const result = await drafts.register({ draftId: 7, source: SOURCE });

  assert.equal(result.error, 'already_decided');
  assert.equal(f.manual.length, 0, '予約は作らない');
});

test('予約の作成に失敗したら、下書きを返事待ちへ戻す', async () => {
  const f = makeFakes(
    [
      [/FROM reservation_drafts d/, { rows: [draftRow()] }],
      [/UPDATE reservation_drafts SET status = 'registered'/, { rows: [{ id: '7' }] }],
    ],
    async () => ({ ok: false, error: 'customer_not_found' })
  );
  const drafts = createReservationDrafts(f);

  await assert.rejects(() => drafts.register({ draftId: 7, source: SOURCE }), /customer_not_found/);
  assert.ok(
    f.pool.queries.some((q) => /SET status = 'pending', decided_at = NULL/.test(q.sql)),
    '押し直せるように戻す'
  );
});

test('新しいお客様の下書きなら、顧客を作ってから予約にする', async () => {
  const f = makeFakes([
    [/FROM reservation_drafts d/, {
      rows: [draftRow({ customer_id: null, customer_name: null, new_customer_name: '山本さくら' })],
    }],
    [/UPDATE reservation_drafts SET status = 'registered'/, { rows: [{ id: '7' }] }],
    [/INSERT INTO customers/, { rows: [{ id: '9' }] }],
  ]);
  const drafts = createReservationDrafts(f);

  const result = await drafts.register({ draftId: 7, source: SOURCE });

  assert.equal(result.createdCustomer, true);
  assert.equal(f.manual[0].customerId, 9);
  const insert = f.pool.queries.find((q) => /INSERT INTO customers/.test(q.sql));
  assert.deepEqual(insert.params, ['山本さくら', null]);
});

test('電話番号が既存と重なるときは、新しく作らずその方に寄せる', async () => {
  const f = makeFakes([
    [/FROM reservation_drafts d/, {
      rows: [draftRow({
        customer_id: null, customer_name: null,
        new_customer_name: '山本さくら', new_customer_phone: '09055556666',
      })],
    }],
    [/UPDATE reservation_drafts SET status = 'registered'/, { rows: [{ id: '7' }] }],
    [/SELECT id FROM customers WHERE phone_norm/, { rows: [{ id: '5' }] }],
  ]);
  const drafts = createReservationDrafts(f);

  await drafts.register({ draftId: 7, source: SOURCE });

  assert.equal(f.manual[0].customerId, 5);
  assert.equal(f.pool.queries.filter((q) => /INSERT INTO customers/.test(q.sql)).length, 0);
});

test('古い下書き・決着済み・場所違いは登録しない', async () => {
  const cases = [
    [draftRow({ fresh: false }), 'expired'],
    [draftRow({ status: 'registered' }), 'already_decided'],
    [draftRow({ customer_id: null, customer_name: null, new_customer_name: null }), 'customer_unresolved'],
  ];
  for (const [row, error] of cases) {
    const f = makeFakes([[/FROM reservation_drafts d/, { rows: [row] }]]);
    const result = await createReservationDrafts(f).register({ draftId: 7, source: SOURCE });
    assert.equal(result.error, error);
    assert.equal(f.manual.length, 0);
  }

  const missing = makeFakes([]);
  const result = await createReservationDrafts(missing).register({ draftId: 7, source: SOURCE });
  assert.deepEqual(result, { ok: false, error: 'not_found' });
});
