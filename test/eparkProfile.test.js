import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateProfile, fill, lineFor, loadProfile } from '../src/epark/profile.js';

const good = () => ({
  loginUrl: 'https://example.test/login',
  login: { user: '#u', password: '#p', submit: 'button', ready: '#dash' },
  day: {
    url: 'https://example.test/schedule',
    script: "moveTo('{dateCompact}')",
    ready: '#today[value="{dateCompact}"]',
  },
  lines: [
    { id: '1', match: ['カット'] },
    { id: '2', match: ['宿泊'] },
  ],
  slotMinutes: 60,
  cell: {
    checkbox: 'input[value="{timeCompact}_{line}"]',
    closed: '.reserveFrame{timeCompact}_{line}',
    open: '.emptyFrame{timeCompact}_{line}',
    ours: '.reserveFrame{timeCompact}_{line} li.tentative-reservation',
  },
  close: [{ click: '{checkbox}' }, { click: '.tentative a' }],
  open: [{ click: '{checkbox}' }, { click: '.cancel a' }],
});

// ---- 差し込み ----

test('差し込みは決まった名前だけを置き換える', () => {
  assert.equal(
    fill('{checkbox} b[data-d="{dateCompact}"] .t{timeCompact} .l{line}', {
      checkbox: '#c', date: '2026-09-01', dateCompact: '20260901', time: '10:00',
      timeCompact: '1000', line: '2',
    }),
    '#c b[data-d="20260901"] .t1000 .l2'
  );
  // 知らない名前は触らない（CSS の波かっこを壊さない）
  assert.equal(fill('a:has-text("{x}")', { line: '1' }), 'a:has-text("{x}")');
});

// ---- ラインの選び方 ----

test('コースの名前でラインを選ぶ', () => {
  const lines = good().lines;
  assert.equal(lineFor('シャンプー＆カットコース', lines).id, '1');
  assert.equal(lineFor('宿泊（レギュラーコース）', lines).id, '2');
});

test('当てはまらないコースは null（勝手にどちらかへ寄せない）', () => {
  // 取り違えて別のラインを閉じるより、人に回すほうが安い
  assert.equal(lineFor('未知のなにか', good().lines), null);
  assert.equal(lineFor(null, good().lines), null);
});

test('fallback を付けたラインがあれば、そこへ寄せる', () => {
  const lines = [{ id: '1', match: ['カット'] }, { id: '9', fallback: true }];
  assert.equal(lineFor('未知のなにか', lines).id, '9');
});

// ---- 設定の検証 ----

test('揃っていれば通る', () => {
  assert.deepEqual(validateProfile(good()), { ok: true });
});

test('設定が無ければ断る', () => {
  assert.equal(validateProfile(null).ok, false);
  assert.match(validateProfile({}).error, /項目が足りません/);
});

test('日付の移動ができない設定は断る（毎回同じ日を開いてしまう）', () => {
  const p = good();
  p.day = { url: 'https://example.test/schedule', ready: '#today' };
  assert.match(validateProfile(p).error, /\{date\} が要ります/);
});

test('URL に日付が入っていれば script は要らない', () => {
  const p = good();
  p.day = { url: 'https://example.test/schedule?date={date}', ready: '#today' };
  assert.equal(validateProfile(p).ok, true);
});

test('開いた日を確かめられない設定は断る', () => {
  const p = good();
  delete p.day.ready;
  assert.match(validateProfile(p).error, /day\.ready/);
});

test('時刻の入らないセレクタは断る（その日の枠を丸ごと掴んでしまう）', () => {
  const p = good();
  p.cell.checkbox = 'input[name="appoint"]';
  assert.match(validateProfile(p).error, /cell\.checkbox に \{timeCompact\}/);
});

test('ラインの入らないセレクタは断る（別の列まで閉じてしまう）', () => {
  const p = good();
  p.cell.closed = '.reserveFrame{timeCompact}';
  assert.match(validateProfile(p).error, /cell\.closed に \{line\}/);
});

test('仮受付の見分けが無ければ断る（本物のご予約を消しかねない）', () => {
  const p = good();
  delete p.cell.ours;
  assert.match(validateProfile(p).error, /cell\.ours/);
});

test('ログインの項目が欠けていれば断る', () => {
  const p = good();
  delete p.login.ready;
  assert.match(validateProfile(p).error, /login\.ready/);
});

test('ラインが1つも無ければ断る', () => {
  assert.match(validateProfile({ ...good(), lines: [] }).error, /lines/);
  const p = good();
  p.lines = [{ match: ['カット'] }];
  assert.match(validateProfile(p).error, /lines\[0\]\.id/);
});

test('手順が空なら断る', () => {
  assert.match(validateProfile({ ...good(), close: [] }).error, /close の手順がありません/);
});

test('1手に操作が2つ、または0なら断る', () => {
  assert.match(validateProfile({ ...good(), open: [{ click: 'a', fill: 'b' }] }).error, /open\[0\]/);
  assert.match(validateProfile({ ...good(), open: [{ nope: 'a' }] }).error, /open\[0\]/);
});

test('入力・選択に値が無ければ断る', () => {
  assert.match(validateProfile({ ...good(), close: [{ fill: '#x' }] }).error, /value がありません/);
});

test('枠の刻みが不正なら断る', () => {
  assert.match(validateProfile({ ...good(), slotMinutes: 0 }).error, /slotMinutes/);
  assert.match(validateProfile({ ...good(), slotMinutes: 1.5 }).error, /slotMinutes/);
});

// ---- 読み込み ----

test('設定ファイルは、指定が無ければ読まない', async () => {
  assert.equal(await loadProfile(null, async () => { throw new Error('読んではいけない'); }), null);
});

test('{base} は .env の値に置き換える（設定ファイルに店舗の識別子を書かない）', async () => {
  const profile = await loadProfile(
    '/x.json',
    async () => JSON.stringify({ ...good(), loginUrl: '{base}/login/index' }),
    'https://example.test/shop'
  );
  assert.equal(profile.loginUrl, 'https://example.test/shop/login/index');
  assert.equal(validateProfile(profile).ok, true);
});

// ---- 顧客検索及び新規受付登録（お名前を載せる手順） ----

const goodRegister = () => ({
  open: '.emptyFrame{timeCompact}_{line} a',
  ready: '#SearchCustomerAndRegisterAppoint',
  verify: ['#hidDate[value="{dateCompact}"]'],
  steps: [{ fill: '#txtMemoNow', value: '{details}' }, { click: '#OP0062UD02' }],
});

test('register は任意（無ければ無名の仮受付で枠だけ押さえる）', () => {
  assert.deepEqual(validateProfile(good()), { ok: true });
  assert.deepEqual(validateProfile({ ...good(), register: goodRegister() }), { ok: true });
});

test('register の項目が欠けていれば断る', () => {
  for (const key of ['open', 'ready', 'steps']) {
    const register = { ...goodRegister() };
    delete register[key];
    assert.match(validateProfile({ ...good(), register }).error, new RegExp(`register\\.${key}`));
  }
});

test('どの枠から開くか決まらない設定は断る（別の時間に予約を入れてしまう）', () => {
  const noTime = { ...goodRegister(), open: '.emptyFrame_{line} a' };
  assert.match(validateProfile({ ...good(), register: noTime }).error, /register\.open に \{timeCompact\}/);

  const noLine = { ...goodRegister(), open: '.emptyFrame{timeCompact} a' };
  assert.match(validateProfile({ ...good(), register: noLine }).error, /register\.open に \{line\}/);
});

test('開くところにお客様の情報は混ぜさせない（セレクタが壊れる）', () => {
  for (const key of ['open', 'ready']) {
    const register = { ...goodRegister(), [key]: `#x{details}{timeCompact}{line}` };
    assert.match(validateProfile({ ...good(), register }).error, /\{details\} は使えません/);
  }
  const register = { ...goodRegister(), verify: ['#hid{details}'] };
  assert.match(validateProfile({ ...good(), register }).error, /register\.verify\[0\]/);
});

test('register の手順が空なら断る', () => {
  const register = { ...goodRegister(), steps: [] };
  assert.match(validateProfile({ ...good(), register }).error, /register\.steps の手順がありません/);
});

test('差し込みは院内メモの中身にも効く', () => {
  assert.equal(fill('{details}', { details: '山田 様' }), '山田 様');
});
