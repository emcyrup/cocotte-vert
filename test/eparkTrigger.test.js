// 予約が入ったその場で EPARK 反映を起こす部分。
//
// ここは「起こすだけ」で、EPARK に何をするかは決めない（live か dry_run かは
// 向こうの設定が持つ）。起こせなかったときに気付けること、そして**予約の登録を
// 巻き添えにしないこと**が要。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEparkTrigger, eparkTriggerFrom } from '../src/epark/trigger.js';

const CONFIG = {
  enabled: true,
  repo: 'owner/repo',
  token: 'ghp_dummy',
  workflow: 'epark-sync.yml',
  ref: 'main',
};

/** 呼ばれた fetch を控える。応答は差し替えられる */
function fakeFetch(reply = () => ({ ok: true, status: 204 })) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return reply(calls.length);
  };
  fn.calls = calls;
  return fn;
}

/** trigger は待たない作りなので、投げた仕事が片付くまで手番を譲る */
const settle = () => new Promise((r) => setImmediate(r));

test('予約が入ると、その場でワークフローを起こす', async () => {
  const fetchFn = fakeFetch();
  const trigger = createEparkTrigger({ config: CONFIG, fetchFn });

  trigger('予約の登録');
  await settle();

  assert.equal(fetchFn.calls.length, 1);
  const [{ url, init }] = fetchFn.calls;
  assert.equal(url, 'https://api.github.com/repos/owner/repo/actions/workflows/epark-sync.yml/dispatches');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer ghp_dummy');
  assert.deepEqual(JSON.parse(init.body), { ref: 'main', inputs: {} });
});

test('モードは渡さない（live かどうかは向こうの設定に委ねる）', async () => {
  const fetchFn = fakeFetch();
  createEparkTrigger({ config: CONFIG, fetchFn })('予約の登録');
  await settle();

  const body = JSON.parse(fetchFn.calls[0].init.body);
  assert.deepEqual(body.inputs, {}, 'mode を送るとガードが2か所に散る');
});

test('設定が無ければ何もしない（起こさない）', async () => {
  const fetchFn = fakeFetch();
  createEparkTrigger({ config: { ...CONFIG, enabled: false }, fetchFn })('予約の登録');
  await settle();
  assert.equal(fetchFn.calls.length, 0);
});

test('走っている間に呼ばれた分は、終わってから1回だけまとめて起こす', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  const fetchFn = fakeFetch((n) => (n === 1 ? held : { ok: true, status: 204 }));
  const trigger = createEparkTrigger({ config: CONFIG, fetchFn });

  trigger('1件目');
  await settle();
  trigger('2件目');
  trigger('3件目');
  await settle();
  assert.equal(fetchFn.calls.length, 1, '走っている間は増やさない');

  release({ ok: true, status: 204 });
  await settle();
  await settle();
  assert.equal(fetchFn.calls.length, 2, '待たせた分は1回にまとめる');
});

test('起こせなければ Slack に出す（定期実行が拾うことも伝える）', async () => {
  const fetchFn = fakeFetch(() => ({ ok: false, status: 403 }));
  const sent = [];
  // **本物の通知部と同じ形（notify）で試す。** send を持つ偽物で試していたせいで、
  // 名前違いに気付けず実物で落ちた
  const slack = { notify: async (t) => { sent.push(t); } };
  const warn = console.warn;
  console.warn = () => {};
  try {
    createEparkTrigger({ config: CONFIG, slack, fetchFn })('予約の登録');
    await settle();
    await settle();
  } finally {
    console.warn = warn;
  }
  assert.equal(sent.length, 1);
  assert.match(sent[0], /403/);
  assert.match(sent[0], /定期実行/, '止まってはいないことを伝える');
  assert.ok(!sent[0].includes('ghp_dummy'), 'トークンは出さない');
});

test('Slack が無くても、通信が落ちても投げない（予約を巻き添えにしない）', async () => {
  const fetchFn = fakeFetch(() => { throw new Error('ECONNREFUSED'); });
  const warn = console.warn;
  const lines = [];
  console.warn = (...a) => lines.push(a.join(' '));
  try {
    createEparkTrigger({ config: CONFIG, fetchFn })('予約の登録');
    await settle();
    await settle();
  } finally {
    console.warn = warn;
  }
  assert.match(lines.join('\n'), /走らせられませんでした/);
});

test('理由はログに出るが、お客様の情報は渡していない', async () => {
  const fetchFn = fakeFetch();
  const log = console.log;
  const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  try {
    createEparkTrigger({ config: CONFIG, fetchFn })('予約の登録');
    await settle();
  } finally {
    console.log = log;
  }
  assert.match(lines.join('\n'), /反映を走らせました（予約の登録）/);
});

test('eparkTriggerFrom は設定が揃っていなければ null', () => {
  assert.equal(eparkTriggerFrom({ config: { epark: { trigger: { enabled: false } } } }), null);
  assert.equal(eparkTriggerFrom({ config: {} }), null);
  assert.equal(typeof eparkTriggerFrom({ config: { epark: { trigger: CONFIG } } }), 'function');
});

// 実物で踏んだ壊れ方。通知部の関数名を取り違えていて、失敗を伝えるはずの行が
// 例外を投げ、**誰も待っていない約束の中から外へ出ていた**（Node は既定で落ちる）。
test('通知部の形が違っても、外へ例外を出さない', async () => {
  const fetchFn = fakeFetch(() => ({ ok: false, status: 403 }));
  const rejections = [];
  const onUnhandled = (err) => rejections.push(err);
  process.on('unhandledRejection', onUnhandled);
  const warn = console.warn;
  const lines = [];
  console.warn = (...a) => lines.push(a.join(' '));
  try {
    // notify も send も持たない通知部
    createEparkTrigger({ config: CONFIG, slack: {}, fetchFn })('予約の登録');
    await settle();
    await settle();
    await settle();
  } finally {
    console.warn = warn;
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(rejections, [], '外へ出さない（プロセスを落とさない）');
  assert.match(lines.join('\n'), /走らせられませんでした/, 'ログには残す');
});

test('通知そのものが落ちても、外へ例外を出さない', async () => {
  const fetchFn = fakeFetch(() => ({ ok: false, status: 403 }));
  const rejections = [];
  const onUnhandled = (err) => rejections.push(err);
  process.on('unhandledRejection', onUnhandled);
  const warn = console.warn;
  console.warn = () => {};
  try {
    const slack = { notify: async () => { throw new Error('Slack が落ちています'); } };
    createEparkTrigger({ config: CONFIG, slack, fetchFn })('予約の登録');
    await settle();
    await settle();
    await settle();
  } finally {
    console.warn = warn;
    process.off('unhandledRejection', onUnhandled);
  }
  assert.deepEqual(rejections, []);
});
