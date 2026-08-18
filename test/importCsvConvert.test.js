import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertCsv, convertRow, rowProblem, DEFAULT_MAPPING } from '../src/import/csv.js';

const MAPPING = {
  externalIdPrefix: 'epark-',
  columns: {
    external_id: '予約番号', customer_name: '氏名', phone: '電話番号',
    reserved_date: '予約日', reserved_time: '予約時間',
    menu: 'メニュー', staff_name: '担当者', status: 'ステータス',
  },
  statusMap: { 予約確定: 'confirmed', 来店済み: 'visited' },
  defaultStatus: 'confirmed',
};

const HEADER = '予約番号,氏名,電話番号,予約日,予約時間,メニュー,担当者,ステータス';

test('CSV 全体を取り込みの形へ変換する', () => {
  const csv = [
    HEADER,
    'R001,山田 花子,090-1234-5678,2026/08/01,14:00,カット,佐藤,予約確定',
    'R002,田中,080-0000-1111,2026/07/19,11:00,,,来店済み',
  ].join('\n');

  const { header, items, problems } = convertCsv(csv, MAPPING);

  assert.equal(header[0], '予約番号');
  assert.deepEqual(problems, []);
  assert.equal(items.length, 2);
  assert.equal(items[0].external_id, 'epark-R001');
  assert.equal(items[0].reserved_at, '2026-08-01T14:00:00+09:00');
  assert.equal(items[1].status, 'visited');
});

test('取り込めない行は落として、行番号と理由を返す', () => {
  const csv = [
    HEADER,
    ',名無し,090-0000-0000,2026/08/01,14:00,,,予約確定',
    'R002,,080-0000-1111,2026/08/01,14:00,,,予約確定',
    'R003,電話なし,,2026/08/01,14:00,,,予約確定',
    'R004,日付おかしい,090-1111-2222,令和8年,14:00,,,予約確定',
    'R005,通る人,090-3333-4444,2026/08/02,10:00,カット,,予約確定',
  ].join('\n');

  const { items, problems } = convertCsv(csv, MAPPING);

  assert.equal(items.length, 1, '通る行だけ残す');
  assert.equal(items[0].customer_name, '通る人');
  assert.deepEqual(problems, [
    { line: 2, reason: '予約番号がありません' },
    { line: 3, reason: 'お名前がありません' },
    { line: 4, reason: '電話番号がありません' },
    { line: 5, reason: '予約日時を読み取れません' },
  ]);
});

test('予約番号が空なら接頭辞だけの目印を作らない', () => {
  // 空の行がすべて「epark-」になると、1件の予約を上書きし合ってしまう
  const item = convertRow(['', '名無し', '090', '2026/08/01', '14:00', '', '', ''], HEADER.split(','), MAPPING);
  assert.equal(item.external_id, null);
  assert.equal(rowProblem(item), '予約番号がありません');
});

test('知らない状態の文言は取り込まない（既定に倒して誤った状態にしない）', () => {
  const mapping = { ...MAPPING, statusMap: {}, defaultStatus: 'confirmed' };
  const withUnknown = { ...MAPPING, statusMap: {}, defaultStatus: 'あいまい' };

  // statusMap に無い文言は defaultStatus に落ちる
  const ok = convertRow(['R1', '名前', '090', '2026/08/01', '14:00', '', '', '謎の状態'], HEADER.split(','), mapping);
  assert.equal(ok.status, 'confirmed');
  assert.equal(rowProblem(ok), null);

  const ng = convertRow(['R1', '名前', '090', '2026/08/01', '14:00', '', '', '謎の状態'], HEADER.split(','), withUnknown);
  assert.match(rowProblem(ng), /状態「あいまい」/);
});

test('日付と時刻が1列の CSV にも対応する', () => {
  const mapping = {
    ...MAPPING,
    columns: { ...MAPPING.columns, reserved_datetime: '予約日時', reserved_date: undefined, reserved_time: undefined },
  };
  const csv = [
    '予約番号,氏名,電話番号,予約日時',
    'R001,山田,090-1234-5678,2026/08/01 14:00',
  ].join('\n');

  const { items } = convertCsv(csv, mapping);
  assert.equal(items[0].reserved_at, '2026-08-01T14:00:00+09:00');
});

test('見出しだけ・空の CSV でも落ちない', () => {
  assert.deepEqual(convertCsv(HEADER, MAPPING), {
    header: HEADER.split(','), items: [], problems: [], statusWords: [],
  });
  assert.deepEqual(convertCsv('', MAPPING), { header: [], items: [], problems: [], statusWords: [] });
});

test('状態の文言は、どう解釈したかを件数つきで返す', () => {
  const csv = [
    HEADER,
    'R001,山田,090-1111-1111,2026/08/01,14:00,,,予約確定',
    'R002,田中,090-2222-2222,2026/08/02,14:00,,,来店済み',
    'R003,鈴木,090-3333-3333,2026/08/03,14:00,,,取消',
    'R004,佐藤,090-4444-4444,2026/08/04,14:00,,,取消',
  ].join('\n');

  const { statusWords } = convertCsv(csv, MAPPING);

  assert.deepEqual(statusWords, [
    { word: '予約確定', status: 'confirmed', known: true, count: 1 },
    { word: '来店済み', status: 'visited', known: true, count: 2 - 1 },
    // 当てはまりが無い文言は既定に落ちる。キャンセルを確定として取り込む事故に気付けるよう返す
    { word: '取消', status: 'confirmed', known: false, count: 2 },
  ]);
});

test('状態の列を使わないときは、読み替えも出さない', () => {
  const mapping = { ...MAPPING, columns: { ...MAPPING.columns, status: undefined } };
  const csv = [HEADER, 'R001,山田,090-1111-1111,2026/08/01,14:00,,,予約確定'].join('\n');
  assert.deepEqual(convertCsv(csv, mapping).statusWords, []);
});

test('既定のマッピングは EPARK の想定列を持つ（実物が来たら画面から直す）', () => {
  assert.equal(DEFAULT_MAPPING.encoding, 'shift_jis');
  for (const key of ['external_id', 'customer_name', 'phone']) {
    assert.ok(DEFAULT_MAPPING.columns[key], key);
  }
});
