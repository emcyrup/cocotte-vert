import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateProfile, fill, loadProfile } from '../src/epark/profile.js';

const good = () => ({
  loginUrl: 'https://example.test/login',
  login: { user: '#u', password: '#p', submit: 'button', ready: '#dash' },
  dayUrl: 'https://example.test/day?date={date}',
  slot: '.slot[data-time="{time}"]',
  closedWhen: '.is-closed',
  close: [{ click: '{slot} a' }, { waitFor: '#dash' }],
  open: [{ click: '{slot} a' }, { waitFor: '#dash' }],
});

test('差し込みは日付・時刻・枠のセレクタだけを置き換える', () => {
  assert.equal(
    fill('{slot} button[data-d="{date}"]', { slot: '.s', date: '2026-09-01', time: '10:00' }),
    '.s button[data-d="2026-09-01"]'
  );
  // 知らない名前は触らない（CSS の波かっこを壊さない）
  assert.equal(fill('a:has-text("{x}")', { slot: '.s' }), 'a:has-text("{x}")');
});

test('揃っていれば通る', () => {
  assert.deepEqual(validateProfile(good()), { ok: true });
});

test('設定が無ければ断る', () => {
  assert.equal(validateProfile(null).ok, false);
  assert.match(validateProfile({}).error, /項目が足りません/);
});

test('日付の入らない dayUrl は断る（毎回同じ日を開いてしまう）', () => {
  const p = { ...good(), dayUrl: 'https://example.test/day' };
  assert.match(validateProfile(p).error, /dayUrl に \{date\}/);
});

test('時刻の入らない slot は断る（その日の全部を閉じてしまう）', () => {
  const p = { ...good(), slot: '.slot' };
  assert.match(validateProfile(p).error, /slot に \{time\}/);
});

test('ログインの項目が欠けていれば断る', () => {
  const p = good();
  delete p.login.ready;
  assert.match(validateProfile(p).error, /login\.ready/);
});

test('手順が空なら断る', () => {
  assert.match(validateProfile({ ...good(), close: [] }).error, /close の手順がありません/);
});

test('1手に操作が2つ、または0なら断る', () => {
  assert.match(
    validateProfile({ ...good(), open: [{ click: 'a', fill: 'b' }] }).error,
    /open\[0\]/
  );
  assert.match(validateProfile({ ...good(), open: [{ nope: 'a' }] }).error, /open\[0\]/);
});

test('入力・選択に値が無ければ断る', () => {
  assert.match(validateProfile({ ...good(), close: [{ fill: '#x' }] }).error, /value がありません/);
});

test('設定ファイルは、指定が無ければ読まない', async () => {
  assert.equal(await loadProfile(null, async () => { throw new Error('読んではいけない'); }), null);
});

test('設定ファイルを読む', async () => {
  const profile = await loadProfile('/x.json', async () => JSON.stringify(good()));
  assert.equal(validateProfile(profile).ok, true);
});
