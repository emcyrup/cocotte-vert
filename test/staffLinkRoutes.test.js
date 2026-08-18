import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createStaffLinkRouter } from '../src/http/staffLinkRoutes.js';

const STAFF_GROUP = 'C-staff';

function makeApp({
  verify = async (token) => (token === 'good' ? { sub: 'U-me' } : Promise.reject(new Error('bad'))),
  membership = async () => 'joined',
  groupId = STAFF_GROUP,
  linkedStaff = null,
  link = async () => ({ ok: true, staff: { id: 1, name: '佐藤' } }),
  linkByName = async () => ({ ok: true, staff: { id: 1, name: '佐藤' } }),
  shiftService = undefined,
} = {}) {
  const linkCalls = [];
  const nameCalls = [];
  const membershipCalls = [];
  const app = express();
  app.use(express.json());
  app.use('/liff/staff', createStaffLinkRouter({
    verifyIdToken: verify,
    settings: { get: async () => groupId },
    config: { staffLineGroupId: null },
    lineClient: {
      getGroupMembership: async (g, u) => { membershipCalls.push({ g, u }); return membership(); },
    },
    shiftService: shiftService === undefined ? {
      findStaffByLineUserId: async () => linkedStaff,
      linkStaffById: async (args) => { linkCalls.push(args); return link(args); },
      linkStaffByTypedName: async (args) => { nameCalls.push(args); return linkByName(args); },
    } : shiftService,
  }));
  app.use((_err, _req, res, _next) => res.status(500).json({ error: 'internal' }));
  return { app, linkCalls, nameCalls, membershipCalls };
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

// ---- 誰が開いたかの確認 ----

test('ID トークンが検証できなければ何も返さない', async () => {
  const { app, membershipCalls } = makeApp();

  for (const path of ['/liff/staff/options', '/liff/staff/link']) {
    const res = await post(app, path, { idToken: 'bogus', staffId: 1 });
    assert.equal(res.status, 401, path);
    assert.equal(res.body.error, 'invalid_token', path);
  }
  assert.equal(membershipCalls.length, 0, '本人が確定するまでグループも見に行かない');
});

test('クライアントが名乗る userId は使わない（ID トークンだけを見る）', async () => {
  const { app, nameCalls } = makeApp();

  await post(app, '/liff/staff/link', { idToken: 'good', name: '佐藤', lineUserId: 'U-somebody-else' });

  assert.equal(nameCalls[0].lineUserId, 'U-me', '検証で得た sub を使う');
});

// ---- スタッフ用グループにいるかの確認 ----

test('スタッフ用グループにいない人は登録できない', async () => {
  const { app, nameCalls } = makeApp({ membership: async () => 'left' });

  const options = await post(app, '/liff/staff/options', { idToken: 'good' });
  assert.equal(options.status, 403);
  assert.equal(options.body.error, 'not_in_group');

  const link = await post(app, '/liff/staff/link', { idToken: 'good', name: '佐藤' });
  assert.equal(link.status, 403);
  assert.equal(nameCalls.length, 0, '画面を飛ばして直接叩かれても止める');
});

test('参加を確認できないときは登録させない（安全側に倒す）', async () => {
  const { app, nameCalls } = makeApp({ membership: async () => 'unknown' });

  const res = await post(app, '/liff/staff/link', { idToken: 'good', name: '佐藤' });

  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'membership_unknown');
  assert.equal(nameCalls.length, 0);
});

test('スタッフ用グループが未設定なら登録できない', async () => {
  const { app, nameCalls } = makeApp({ groupId: null });

  const res = await post(app, '/liff/staff/options', { idToken: 'good' });

  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'group_not_configured');
  assert.equal(nameCalls.length, 0);
});

test('設定済みのグループに対して参加を確かめる', async () => {
  const { app, membershipCalls } = makeApp();
  await post(app, '/liff/staff/options', { idToken: 'good' });
  assert.deepEqual(membershipCalls[0], { g: STAFF_GROUP, u: 'U-me' });
});

test('LIFF やシフト機能が未設定なら使えない', async () => {
  for (const opts of [{ verify: null }, { shiftService: null }]) {
    const { app } = makeApp(opts);
    const res = await post(app, '/liff/staff/options', { idToken: 'good' });
    assert.equal(res.status, 403);
    assert.equal(res.body.error, 'liff_not_configured');
  }
});

// ---- 一覧と登録 ----

test('通った人には、登録済みかどうかだけを返す（名簿は出さない）', async () => {
  const { app } = makeApp({ linkedStaff: { id: 2, name: '高橋' } });

  const res = await post(app, '/liff/staff/options', { idToken: 'good' });

  assert.equal(res.status, 200);
  assert.equal(res.body.eligible, true);
  assert.deepEqual(res.body.linkedStaff, { id: 2, name: '高橋' });
  assert.equal(res.body.staff, undefined, '名前は本人が入力するので、名簿は返さない');
});

test('入力された名前で登録する', async () => {
  const { app, nameCalls } = makeApp();

  const res = await post(app, '/liff/staff/link', { idToken: 'good', name: '佐藤' });

  assert.deepEqual(res.body, { ok: true, staff: { id: 1, name: '佐藤' }, created: false });
  assert.deepEqual(nameCalls[0], { lineUserId: 'U-me', name: '佐藤' });
});

test('新しく作られたときは、その旨を返す', async () => {
  const { app } = makeApp({
    linkByName: async () => ({ ok: true, staff: { id: 9, name: '新人' }, created: true }),
  });

  const res = await post(app, '/liff/staff/link', { idToken: 'good', name: '新人' });

  assert.equal(res.body.created, true);
});

test('同姓が複数いたら、候補を返して選ばせる', async () => {
  const candidates = [{ id: 1, name: '佐藤', linked: true }, { id: 5, name: '佐藤', linked: false }];
  const { app } = makeApp({ linkByName: async () => ({ ok: false, error: 'ambiguous', candidates }) });

  const res = await post(app, '/liff/staff/link', { idToken: 'good', name: '佐藤' });

  assert.equal(res.status, 409);
  assert.deepEqual(res.body.candidates, candidates);
});

test('選ばれた候補は id で紐付ける（名前では決められないため）', async () => {
  const { app, linkCalls, nameCalls } = makeApp();

  const res = await post(app, '/liff/staff/link', { idToken: 'good', staffId: 5 });

  assert.equal(res.status, 200);
  assert.deepEqual(linkCalls[0], { lineUserId: 'U-me', staffId: 5 });
  assert.equal(nameCalls.length, 0);
});

test('壊れた staffId は受け付けない', async () => {
  const { app, linkCalls } = makeApp();

  for (const staffId of [0, -1, 'abc', 1.5]) {
    const res = await post(app, '/liff/staff/link', { idToken: 'good', staffId });
    assert.equal(res.status, 400, String(staffId));
    assert.equal(res.body.error, 'invalid_staff', String(staffId));
  }
  assert.equal(linkCalls.length, 0);
});

test('名前の書き方の問題は 400 で返す', async () => {
  const { app } = makeApp({ linkByName: async () => ({ ok: false, error: 'invalid_name' }) });

  const res = await post(app, '/liff/staff/link', { idToken: 'good', name: '' });

  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_name');
});

test('紐付けに失敗した理由をそのまま画面へ返す', async () => {
  for (const error of ['already_linked_to_other', 'staff_taken', 'not_found']) {
    const { app } = makeApp({ link: async () => ({ ok: false, error }) });
    const res = await post(app, '/liff/staff/link', { idToken: 'good', staffId: 1 });
    assert.equal(res.status, 409, error);
    assert.equal(res.body.error, error);
  }
});

test('同じ名前が登録済みなら、その名前を添えて 409 で返す', async () => {
  const { app } = makeApp({
    linkByName: async () => ({ ok: false, error: 'name_taken', staff: { name: '高橋' } }),
  });

  const res = await post(app, '/liff/staff/link', { idToken: 'good', name: '高橋' });

  assert.equal(res.status, 409);
  assert.equal(res.body.error, 'name_taken');
  assert.deepEqual(res.body.staff, { name: '高橋' });
});
