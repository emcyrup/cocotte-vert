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
  assert.deepEqual(sanitizeEntry(full), { ...full, nights: null, checkoutDate: null });
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

// ---- お泊まり ----

test('泊数から退室日を出す', () => {
  const result = sanitizeEntry({ ...full, nights: 2, checkoutDate: null });
  assert.equal(result.nights, 2);
  assert.equal(result.checkoutDate, '2026-08-22');
});

test('退室日から泊数を出す（月をまたいでも数え違えない）', () => {
  const result = sanitizeEntry({ ...full, date: '2026-08-30', nights: null, checkoutDate: '2026-09-02' });
  assert.equal(result.nights, 3);
  assert.equal(result.checkoutDate, '2026-09-02');
});

test('泊数と退室日が食い違うときは退室日を採る', () => {
  const result = sanitizeEntry({ ...full, nights: 5, checkoutDate: '2026-08-21' });
  assert.equal(result.nights, 1);
  assert.equal(result.checkoutDate, '2026-08-21');
});

test('読み違いとしか思えない泊数・退室日は宿泊なしに落とす', () => {
  const cases = [
    { nights: 0, checkoutDate: null },
    { nights: 31, checkoutDate: null },
    { nights: null, checkoutDate: '2026-08-20' },   // 入室日と同じ
    { nights: null, checkoutDate: '2026-08-19' },   // 入室日より前
    { nights: null, checkoutDate: '2026-02-30' },   // 存在しない日
    { nights: null, checkoutDate: '8/22' },
  ];
  for (const over of cases) {
    const result = sanitizeEntry({ ...full, ...over });
    assert.equal(result.isRequest, true, JSON.stringify(over));
    assert.deepEqual(
      [result.nights, result.checkoutDate], [null, null], JSON.stringify(over)
    );
  }
});

// ---- 読み取らずに書き直してもらう場合 ----

test('1通に複数件あれば、理由を添えて読み取らない', () => {
  assert.deepEqual(sanitizeEntry({ ...full, entryCount: 2 }), { isRequest: false, reason: 'multiple' });
  // 1件・未指定は通す
  for (const entryCount of [1, null, undefined]) {
    assert.equal(sanitizeEntry({ ...full, entryCount }).isRequest, true, String(entryCount));
  }
});

test('わんちゃんの名前しか無ければ、飼い主様の名前を聞き直す', () => {
  assert.deepEqual(
    sanitizeEntry({ ...full, isRequest: false, customerName: null, petName: 'ココ' }),
    { isRequest: false, reason: 'pet_only' }
  );
  // 飼い主様の名前があれば、わんちゃんの名前が添えられていても通す
  assert.equal(sanitizeEntry({ ...full, petName: 'ココ' }).isRequest, true);
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

test('今日の日付と営業時間を渡して、相対表現と「2時」を解決させる', async () => {
  let body = null;
  const parser = createReservationEntryParser({
    apiKey: 'k',
    store: { openTime: '10:00', closeTime: '19:00' },
    fetchFn: async (_url, opts) => {
      body = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ content: [{ text: JSON.stringify(full) }] }) };
    },
  });
  const result = await parser.parse({ text: '明日14時 田中花子', today: '2026-08-19' });

  assert.equal(result.isRequest, true);
  assert.match(body.system, /今日の日付（JST）: 2026-08-19/);
  assert.match(body.system, /営業時間（JST）: 10:00〜19:00/);
});

test('営業時間が渡されていなくても動く（行ごと出さない）', async () => {
  let body = null;
  const parser = createReservationEntryParser({
    apiKey: 'k',
    fetchFn: async (_url, opts) => {
      body = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ content: [{ text: JSON.stringify(full) }] }) };
    },
  });
  await parser.parse({ text: '明日14時 田中花子', today: '2026-08-19' });
  assert.doesNotMatch(body.system, /営業時間（JST）:/);
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
