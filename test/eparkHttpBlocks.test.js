import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHttpBlocks } from '../src/epark/httpBlocks.js';

function makeFetch(handler) {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url, options });
    return handler(url, options);
  };
  return { fetchFn, calls };
}

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const fail = (status, body = {}) => ({ ok: false, status, json: async () => body });

const blocks = (fetchFn) =>
  createHttpBlocks({ baseUrl: 'https://example.test/', user: 'admin', password: 'pw', fetchFn });

test('一覧は個人情報を含まない形（fields=sync）で取りに行く', async () => {
  const { fetchFn, calls } = makeFetch(() => ok({ toBlock: [{ id: 1 }], toRelease: [] }));

  const result = await blocks(fetchFn).listPending();

  assert.deepEqual(result, { toBlock: [{ id: 1 }], toRelease: [] });
  assert.equal(calls[0].url, 'https://example.test/api/admin/external-blocks?fields=sync');
});

test('末尾のスラッシュがあっても URL が壊れない', async () => {
  const { fetchFn, calls } = makeFetch(() => ok({}));
  await createHttpBlocks({
    baseUrl: 'https://example.test/', user: 'a', password: 'b', fetchFn,
  }).listPending();
  assert.doesNotMatch(calls[0].url, /\/\/api/);
});

test('管理画面と同じ Basic 認証を付ける', async () => {
  const { fetchFn, calls } = makeFetch(() => ok({}));
  await blocks(fetchFn).listPending();
  const expected = `Basic ${Buffer.from('admin:pw').toString('base64')}`;
  assert.equal(calls[0].options.headers.Authorization, expected);
});

test('消し込みでは、閉じた枠も一緒に送る', async () => {
  const { fetchFn, calls } = makeFetch(() => ok({ ok: true }));

  const result = await blocks(fetchFn).setDone({ id: 5, done: true, cells: ['10:00', '11:00'] });

  assert.deepEqual(result, { ok: true });
  assert.equal(calls[0].url, 'https://example.test/api/admin/external-blocks/5');
  assert.equal(calls[0].options.method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[0].options.body), { done: true, cells: ['10:00', '11:00'] });
});

test('壊れた id は問い合わせずに断る', async () => {
  const { fetchFn, calls } = makeFetch(() => ok({}));
  const b = blocks(fetchFn);

  for (const id of [0, -1, 1.5, NaN, undefined]) {
    assert.deepEqual(await b.setDone({ id, done: true }), { ok: false, error: 'invalid_id' }, String(id));
  }
  assert.equal(calls.length, 0);
});

test('認証に失敗したら、その理由が分かるようにする', async () => {
  // 黙って0件になると「作業が無い」と見分けが付かない
  const { fetchFn } = makeFetch(() => fail(401));
  await assert.rejects(() => blocks(fetchFn).listPending(), /管理画面にログインできません/);
});

test('一覧が取れなければ例外にする（0件として扱わない）', async () => {
  const { fetchFn } = makeFetch(() => fail(503, { error: 'unavailable' }));
  await assert.rejects(() => blocks(fetchFn).listPending(), /unavailable/);
});

test('記録できなければ ok:false を返す（sync 側が失敗として残す）', async () => {
  const { fetchFn } = makeFetch(() => fail(404, { error: 'not_found' }));
  const result = await blocks(fetchFn).setDone({ id: 5, done: true });
  assert.equal(result.ok, false);
  assert.match(result.error, /not_found/);
});

test('通信そのものが失敗しても投げっぱなしにしない', async () => {
  const { fetchFn } = makeFetch(() => { throw new Error('通信断'); });
  const result = await blocks(fetchFn).setDone({ id: 5, done: true });
  assert.deepEqual(result, { ok: false, error: '通信断' });
});

test('お名前を仮受付に載せるときだけ、氏名・電話番号も取りに行く', async () => {
  const { fetchFn, calls } = makeFetch(() => ok({ toBlock: [], toRelease: [] }));
  await createHttpBlocks({
    baseUrl: 'https://example.test', user: 'a', password: 'b', details: true, fetchFn,
  }).listPending();
  assert.equal(calls[0].url, 'https://example.test/api/admin/external-blocks?fields=sync&details=1');
});
