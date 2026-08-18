import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeEntry, createReservationEntryParser } from '../src/ai/parseReservationEntry.js';

const full = {
  isRequest: true,
  customerName: '田中花子',
  phone: '090-1234-5678',
  date: '2026-08-20',
  time: '14:00',
  menu: 'カット',
  staffName: '佐藤',
  durationMinutes: 90,
};

test('揃っていれば予約として通す', () => {
  assert.deepEqual(sanitizeEntry(full), full);
});

test('お名前・日付・時刻のどれかが欠けたら通さない', () => {
  for (const key of ['customerName', 'date', 'time']) {
    assert.deepEqual(sanitizeEntry({ ...full, [key]: null }), { isRequest: false }, key);
    assert.deepEqual(sanitizeEntry({ ...full, [key]: '  ' }), { isRequest: false }, key);
  }
});

test('日付・時刻の形が違えば通さない', () => {
  for (const date of ['8/20', '2026-8-20', '20260820']) {
    assert.deepEqual(sanitizeEntry({ ...full, date }), { isRequest: false }, date);
  }
  for (const time of ['14時', '25:00', '9:0', '14:60']) {
    assert.deepEqual(sanitizeEntry({ ...full, time }), { isRequest: false }, time);
  }
});

test('存在しない日は通さない（Date が繰り上げてしまうため）', () => {
  assert.deepEqual(sanitizeEntry({ ...full, date: '2026-02-30' }), { isRequest: false });
  assert.deepEqual(sanitizeEntry({ ...full, date: '2026-13-01' }), { isRequest: false });
  // うるう年の 2/29 は通す
  assert.equal(sanitizeEntry({ ...full, date: '2028-02-29' }).isRequest, true);
});

test('所要時間は範囲外なら未指定に落とす（コースの所要時間に従わせる）', () => {
  for (const durationMinutes of [0, -30, 1441, 60.5, '90', null]) {
    assert.equal(sanitizeEntry({ ...full, durationMinutes }).durationMinutes, null, String(durationMinutes));
  }
  assert.equal(sanitizeEntry({ ...full, durationMinutes: 1440 }).durationMinutes, 1440);
});

test('コース・担当・電話番号は無くてもよい', () => {
  const result = sanitizeEntry({ ...full, menu: null, staffName: '', phone: '  ' });
  assert.equal(result.isRequest, true);
  assert.deepEqual([result.menu, result.staffName, result.phone], [null, null, null]);
});

test('isRequest が false ならそのまま落とす', () => {
  assert.deepEqual(sanitizeEntry({ ...full, isRequest: false }), { isRequest: false });
  assert.deepEqual(sanitizeEntry(null), { isRequest: false });
});

test('APIキーが無ければ問い合わせずに読み取れない扱いにする', async () => {
  let called = false;
  const parser = createReservationEntryParser({
    apiKey: null,
    fetchFn: async () => { called = true; },
  });
  assert.deepEqual(await parser.parse({ text: 'x', today: '2026-08-18' }), { isRequest: false });
  assert.equal(called, false);
});

test('今日の日付を渡して相対表現を解決させる', async () => {
  let body = null;
  const parser = createReservationEntryParser({
    apiKey: 'k',
    fetchFn: async (_url, opts) => {
      body = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ content: [{ text: JSON.stringify(full) }] }) };
    },
  });
  const result = await parser.parse({ text: '明日14時 田中花子', today: '2026-08-19' });

  assert.equal(result.isRequest, true);
  assert.match(body.system, /今日の日付（JST）: 2026-08-19/);
});

test('API エラー・壊れた本文では予約を作らない', async () => {
  const cases = [
    async () => ({ ok: false, status: 500 }),
    async () => ({ ok: true, json: async () => ({ stop_reason: 'refusal' }) }),
    async () => ({ ok: true, json: async () => ({ content: [{ text: 'これはJSONではない' }] }) }),
    async () => { throw new Error('timeout'); },
  ];
  for (const fetchFn of cases) {
    const parser = createReservationEntryParser({ apiKey: 'k', fetchFn });
    assert.deepEqual(await parser.parse({ text: 'x', today: '2026-08-18' }), { isRequest: false });
  }
});
