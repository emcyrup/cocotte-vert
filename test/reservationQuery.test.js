import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseReservationQuery,
  createReservationQuery,
} from '../src/webhook/events/reservationQuery.js';

// JST 2026-08-17(月) 昼。UTC では 03:00
const NOW = new Date('2026-08-17T03:00:00Z');
const on = (text, now = NOW) => parseReservationQuery(text, now)?.date ?? null;

test('今日・明日・明後日を JST で解釈する', () => {
  for (const t of ['今日の予約', '本日の予約', 'きょうの予約', '今日の予約確認']) {
    assert.equal(on(t), '2026-08-17', t);
  }
  for (const t of ['明日の予約', 'あしたの予約', 'あすの予約']) {
    assert.equal(on(t), '2026-08-18', t);
  }
  for (const t of ['明後日の予約', 'あさっての予約']) {
    assert.equal(on(t), '2026-08-19', t);
  }
});

test('「予約」だけなら今日', () => {
  for (const t of ['予約', '予約確認', '予約一覧']) assert.equal(on(t), '2026-08-17', t);
});

test('空白・記号の揺れを吸収する', () => {
  for (const t of ['今日 の 予約', '今日の予約？', '　明日の予約！']) {
    assert.ok(on(t), t);
  }
});

test('日付指定（月あり・月なし）', () => {
  assert.equal(on('8/20の予約'), '2026-08-20');
  assert.equal(on('8月20日の予約'), '2026-08-20');
  assert.equal(on('9/1の予約'), '2026-09-01');
  // 月を省略した日が今日より前なら来月とみなす
  assert.equal(on('20日の予約'), '2026-08-20');
  assert.equal(on('5日の予約'), '2026-09-05');
});

test('月をまたぐ年の寄せ方', () => {
  const dec = new Date('2026-12-28T03:00:00Z'); // JST 12/28
  assert.equal(on('1/5の予約', dec), '2027-01-05', '12月に1月を聞かれたら翌年');
  const jan = new Date('2027-01-05T03:00:00Z'); // JST 1/5
  assert.equal(on('12/28の予約', jan), '2026-12-28', '1月に12月を聞かれたら前年');
  // 月をまたぐ「日だけ」の指定でも年が繰り上がる
  assert.equal(on('3日の予約', new Date('2026-12-28T03:00:00Z')), '2027-01-03');
});

test('存在しない日付・予約と無関係な発言は拾わない', () => {
  for (const t of ['2/30の予約', '13/1の予約', '今日の天気', 'おはようございます', '予約の件どうする']) {
    assert.equal(on(t), null, t);
  }
});

// ---- 一覧の組み立て ----

function makePool(rows) {
  const calls = [];
  return {
    calls,
    pool: {
      query: async (sql, params) => {
        calls.push({ sql, params });
        return { rows };
      },
    },
  };
}

const row = (o) => ({
  reserved_at: new Date('2026-08-20T01:00:00Z'), // JST 10:00
  menu: 'シャンプー＆カットコース',
  status: 'confirmed',
  customer_name: '山田',
  staff_name: '佐藤',
  ...o,
});

test('件数・時刻・コース・担当が入る', async () => {
  const { pool } = makePool([
    row({}),
    row({ reserved_at: new Date('2026-08-20T04:30:00Z'), customer_name: '田中', staff_name: null }),
  ]);
  const text = await createReservationQuery({ pool }).summarize('2026-08-20');

  assert.match(text, /8月20日\(木\) のご予約 2件/);
  assert.match(text, /10:00 山田様/);
  assert.match(text, /シャンプー＆カットコース／佐藤/);
  assert.match(text, /13:30 田中様/);
  assert.match(text, /担当未定/, '担当が空なら「担当未定」');
});

test('日付は JST で突き合わせる', async () => {
  const { pool, calls } = makePool([]);
  await createReservationQuery({ pool }).summarize('2026-08-20');
  assert.match(calls[0].sql, /AT TIME ZONE 'Asia\/Tokyo'\)::date = \$1::date/);
  assert.deepEqual(calls[0].params, ['2026-08-20']);
});

test('0件のときはその旨だけ返す', async () => {
  const { pool } = makePool([]);
  const text = await createReservationQuery({ pool }).summarize('2026-08-20');
  assert.equal(text, '8月20日(木) のご予約はありません。');
});

test('承認待ちは印を付け、件数も添える', async () => {
  const { pool } = makePool([row({ status: 'requested' }), row({})]);
  const text = await createReservationQuery({ pool }).summarize('2026-08-20');
  assert.match(text, /※承認待ち/);
  assert.match(text, /承認待ちが1件あります/);
});

test('来店済・無断キャンセルも状態が分かる', async () => {
  const { pool } = makePool([row({ status: 'visited' }), row({ status: 'no_show' })]);
  const text = await createReservationQuery({ pool }).summarize('2026-08-20');
  assert.match(text, /（来店済）/);
  assert.match(text, /※無断キャンセル/);
});

test('キャンセルは SQL の時点で除外する', async () => {
  const { pool, calls } = makePool([]);
  await createReservationQuery({ pool }).summarize('2026-08-20');
  assert.match(calls[0].sql, /status <> 'cancelled'/);
});

test('多い日は打ち切って残件数を伝える', async () => {
  const { pool } = makePool(Array.from({ length: 35 }, () => row({})));
  const text = await createReservationQuery({ pool }).summarize('2026-08-20');
  assert.match(text, /ご予約 35件/);
  assert.match(text, /残り5件は管理画面/);
  // LINE のテキスト上限（5000文字）に当たらない
  assert.ok(text.length < 5000, `長すぎます: ${text.length}`);
});
