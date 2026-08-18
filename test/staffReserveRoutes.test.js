import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createStaffReserveRouter } from '../src/http/staffReserveRoutes.js';

const STAFF_GROUP = 'C-staff';

function makeApp({
  verify = async (token) => (token === 'good' ? { sub: 'U-me' } : Promise.reject(new Error('bad'))),
  membership = async () => 'joined',
  groupId = STAFF_GROUP,
  linkedStaff = null,
  rows = [],
  createManual = async () => ({ ok: true, reservationId: 42 }),
  drafts = undefined,
} = {}) {
  const queries = [];
  const manual = [];
  const created = [];
  const membershipCalls = [];
  const app = express();
  app.use(express.json());
  app.use('/liff/staff-reserve', createStaffReserveRouter({
    verifyIdToken: verify,
    settings: { get: async () => groupId },
    config: { staffLineGroupId: null },
    store: { openTime: '10:00', closeTime: '19:00' },
    lineClient: {
      getGroupMembership: async (g, u) => { membershipCalls.push({ g, u }); return membership(); },
    },
    shiftService: { findStaffByLineUserId: async () => linkedStaff },
    pool: {
      query: async (sql, params) => {
        queries.push({ sql, params });
        for (const [re, result] of rows) {
          if (re.test(sql)) return { rows: typeof result === 'function' ? result(params) : result };
        }
        return { rows: [] };
      },
    },
    reservationService: {
      createManual: async (args) => { manual.push(args); return createManual(args); },
    },
    drafts: drafts ?? {
      createCustomer: async (args) => { created.push(args); return 9; },
    },
  }));
  app.use((_err, _req, res, _next) => res.status(500).json({ error: 'internal' }));
  return { app, queries, manual, created, membershipCalls };
}

async function post(app, path, body) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  } finally {
    server.close();
  }
}

const OK_CREATE = {
  idToken: 'good',
  customerId: 3,
  reservedAt: '2026-08-20T14:00:00+09:00',
  menu: 'カット',
  staffId: 1,
};

// ---- 誰が開いたか ----

test('ID トークンが検証できなければ、どの入口も通さない', async () => {
  const { app, queries } = makeApp();

  for (const path of ['/options', '/customers', '/create']) {
    const res = await post(app, `/liff/staff-reserve${path}`, { idToken: 'bogus', q: '田中' });
    assert.equal(res.status, 401, path);
    assert.equal(res.body.error, 'invalid_token', path);
  }
  assert.equal(queries.length, 0, '本人が確定するまで顧客を探しに行かない');
});

test('連携済みのスタッフなら、グループを見に行かずに使える（1:1 から開くため）', async () => {
  const { app, membershipCalls } = makeApp({ linkedStaff: { id: 5, name: '高橋' } });

  const res = await post(app, '/liff/staff-reserve/options', { idToken: 'good' });

  assert.equal(res.body.eligible, true);
  assert.deepEqual(res.body.me, { id: 5, name: '高橋' });
  assert.equal(membershipCalls.length, 0);
});

test('連携していない人は、スタッフ用グループの参加者だけ通す', async () => {
  const joined = makeApp();
  const ok = await post(joined.app, '/liff/staff-reserve/options', { idToken: 'good' });
  assert.equal(ok.body.eligible, true);
  assert.equal(ok.body.me, null, '連携していなければ担当の初期値は出さない');
  assert.deepEqual(joined.membershipCalls[0], { g: STAFF_GROUP, u: 'U-me' });

  for (const [membership, error] of [['left', 'not_in_group'], ['unknown', 'membership_unknown']]) {
    const { app, queries } = makeApp({ membership: async () => membership });
    const res = await post(app, '/liff/staff-reserve/create', OK_CREATE);
    assert.equal(res.status, 403, membership);
    assert.equal(res.body.error, error, membership);
    assert.equal(queries.length, 0, '画面を飛ばして直接叩かれても止める');
  }
});

test('スタッフ用グループが未設定なら使えない', async () => {
  const { app } = makeApp({ groupId: null });
  const res = await post(app, '/liff/staff-reserve/options', { idToken: 'good' });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'group_not_configured');
});

// ---- お客様を探す ----

test('飼い主様の名前・電話番号・わんちゃんの名前のどれでも探す', async () => {
  const { app, queries } = makeApp({
    rows: [[/FROM customers c/, [
      { id: '3', name: '田中花子', phone_last4: '5678', pets: ['ココ'] },
    ]]],
  });

  const res = await post(app, '/liff/staff-reserve/customers', { idToken: 'good', q: 'ココ' });

  assert.deepEqual(res.body.customers, [
    { id: 3, name: '田中花子', phoneLast4: '5678', pets: ['ココ'] },
  ]);
  const { sql, params } = queries[0];
  assert.match(sql, /FROM pets p2/, 'わんちゃんの名前でも引く');
  assert.equal(params[0], 'ココ');
  assert.equal(params[1], null, '数字が無ければ電話番号としては照合しない');
});

test('数字で探すときは、ハイフンを除いて電話番号と突き合わせる', async () => {
  const { app, queries } = makeApp();
  await post(app, '/liff/staff-reserve/customers', { idToken: 'good', q: '090-1234' });
  assert.equal(queries[0].params[1], '0901234');
});

test('ILIKE のパターン文字は落とす（全件が当たってしまうため）', async () => {
  const { app, queries } = makeApp();
  await post(app, '/liff/staff-reserve/customers', { idToken: 'good', q: '%_田中' });
  assert.equal(queries[0].params[0], '田中');
});

test('空の検索語は受け付けない', async () => {
  const { app, queries } = makeApp();
  for (const q of ['', '   ', '%%', null, 'あ'.repeat(31)]) {
    const res = await post(app, '/liff/staff-reserve/customers', { idToken: 'good', q });
    assert.equal(res.status, 400, String(q));
    assert.equal(res.body.error, 'invalid_query', String(q));
  }
  assert.equal(queries.length, 0);
});

// ---- 登録 ----

test('選ばれたお客様で予約を作る', async () => {
  const { app, manual } = makeApp();

  const res = await post(app, '/liff/staff-reserve/create', OK_CREATE);

  assert.deepEqual(res.body, { ok: true, createdCustomer: false, stay: null });
  assert.deepEqual(manual[0], {
    customerId: 3,
    reservedAt: '2026-08-20T14:00:00+09:00',
    menu: 'カット',
    staffId: 1,
    durationMinutes: null,
    note: null,
  });
});

test('新規のお客様は、名前だけでも作れる（電話番号は任意）', async () => {
  const { app, manual, created } = makeApp();

  const res = await post(app, '/liff/staff-reserve/create', {
    ...OK_CREATE,
    customerId: null,
    newCustomerName: '山本さくら',
    newCustomerPhone: '090-1111-2222',
  });

  assert.equal(res.body.createdCustomer, true);
  assert.deepEqual(created[0], { name: '山本さくら', phone: '09011112222' });
  assert.equal(manual[0].customerId, 9);
});

test('お客様が決まっていなければ登録しない', async () => {
  const { app, manual } = makeApp();

  for (const over of [{ customerId: null }, { customerId: 0 }, { customerId: 'abc' },
    { customerId: null, newCustomerName: '  ' }]) {
    const res = await post(app, '/liff/staff-reserve/create', { ...OK_CREATE, ...over });
    assert.equal(res.status, 400, JSON.stringify(over));
    assert.equal(res.body.error, 'invalid_customer', JSON.stringify(over));
  }
  assert.equal(manual.length, 0);
});

test('日時は JST を明示した形しか受け付けない（端末の時計に振り回されないため）', async () => {
  const { app, manual } = makeApp();

  for (const reservedAt of ['2026-08-20T14:00', '2026-08-20T14:00:00Z', '2026-08-20 14:00:00+09:00',
    '2026-08-20T25:00:00+09:00', null]) {
    const res = await post(app, '/liff/staff-reserve/create', { ...OK_CREATE, reservedAt });
    assert.equal(res.status, 400, String(reservedAt));
    assert.equal(res.body.error, 'invalid_reserved_at', String(reservedAt));
  }
  assert.equal(manual.length, 0);
});

test('お泊まりは、退室日を予約のメモへ残す', async () => {
  const { app, manual } = makeApp();

  const res = await post(app, '/liff/staff-reserve/create', {
    ...OK_CREATE, checkoutDate: '2026-08-22', note: 'お迎えは夕方',
  });

  assert.equal(res.body.stay, '2泊（8月22日(土) 退室予定）');
  assert.equal(manual[0].note, 'お泊まり 2泊（8月22日(土) 退室予定）\nお迎えは夕方');
});

test('退室日が入室日以前・形が違うものは受け付けない', async () => {
  const { app, manual } = makeApp();

  for (const checkoutDate of ['2026-08-20', '2026-08-19', '8/22', '2026-02-30']) {
    const res = await post(app, '/liff/staff-reserve/create', { ...OK_CREATE, checkoutDate });
    assert.equal(res.status, 400, checkoutDate);
    assert.equal(res.body.error, 'invalid_checkout', checkoutDate);
  }
  assert.equal(manual.length, 0);
});

test('壊れた担当は受け付けない', async () => {
  const { app, manual } = makeApp();
  const res = await post(app, '/liff/staff-reserve/create', { ...OK_CREATE, staffId: 'abc' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_staff');
  assert.equal(manual.length, 0);
});

test('予約の作成が断られたら、その理由をそのまま画面へ返す', async () => {
  const { app } = makeApp({ createManual: async () => ({ ok: false, error: 'invalid_duration' }) });
  const res = await post(app, '/liff/staff-reserve/create', { ...OK_CREATE, durationMinutes: 9999 });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_duration');
});

test('コース・担当・メモは無くてもよい', async () => {
  const { app, manual } = makeApp();

  const res = await post(app, '/liff/staff-reserve/create', {
    idToken: 'good', customerId: 3, reservedAt: '2026-08-20T14:00:00+09:00',
  });

  assert.equal(res.body.ok, true);
  assert.deepEqual(
    [manual[0].menu, manual[0].staffId, manual[0].durationMinutes, manual[0].note],
    [null, null, null, null]
  );
});
