import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEparkSync } from '../src/epark/sync.js';
import { createNullDriver, isValidDriver } from '../src/epark/driver.js';
import { slotOf, slotLabel, DEFAULT_DURATION_MINUTES } from '../src/epark/slot.js';

const row = (over = {}) => ({
  id: 1, reserved_at: '2026-09-01T01:00:00.000Z', menu: 'カット',
  status: 'confirmed', duration_minutes: 60, customer_name: '田中花子', ...over,
});

function makeFakes({ toBlock = [], toRelease = [], driver = {}, mode = 'live' } = {}) {
  const calls = [];
  const notices = [];
  const done = [];
  const base = {
    async open() { calls.push(['open']); },
    async close() { calls.push(['close']); },
    async closeSlot(s) { calls.push(['closeSlot', s.reservationId]); },
    async openSlot(s) { calls.push(['openSlot', s.reservationId]); },
    async isSlotClosed(s) { calls.push(['isSlotClosed', s.reservationId]); return true; },
  };
  const sync = createEparkSync({
    externalBlocks: {
      listPending: async () => ({ toBlock, toRelease }),
      setDone: async (args) => { done.push(args); return { ok: true }; },
    },
    driver: { ...base, ...driver },
    slack: {
      notify: async (t) => { notices.push(t); },
      notifyError: async (c, e) => { notices.push(`${c}: ${e.message}`); },
    },
    config: { epark: { mode } },
  });
  return { sync, calls, notices, done };
}

// ---- 枠の切り出し ----

test('予約から JST の日付・開始・終了と、またがる枠を作る', () => {
  // 10:00 JST = 01:00 UTC。サーバーの TZ に関わらず JST で確定させる
  const slot = slotOf(row({ reserved_at: '2026-09-01T01:00:00.000Z', duration_minutes: 90 }));
  assert.equal(slot.date, '2026-09-01');
  assert.equal(slot.dateCompact, '20260901');
  assert.equal(slot.startTime, '10:00');
  assert.equal(slot.endTime, '11:30');
  // 1枠しか閉じないと、はみ出した時間に別のお客様が入れてしまう
  assert.deepEqual(slot.cells, ['10:00', '11:00']);
});

test('枠の頭からずれた予約は、またがる枠を頭から拾う', () => {
  // 10:30 JST 開始の60分 → 10:00 と 11:00 の枠にかかる
  const slot = slotOf(row({ reserved_at: '2026-09-01T01:30:00.000Z', duration_minutes: 60 }));
  assert.deepEqual(slot.cells, ['10:00', '11:00']);
});

test('日をまたぐ予約でも、その日の枠までしか閉じない', () => {
  // 23:00 JST 開始の3時間。翌日の枠は勝手に触らない
  const slot = slotOf(row({ reserved_at: '2026-09-01T14:00:00.000Z', duration_minutes: 180 }));
  assert.deepEqual(slot.cells, ['23:00']);
});

test('所要時間が無い予約は既定の枠にする（狭く閉じて隣に入られるのを避ける）', () => {
  const slot = slotOf(row({ duration_minutes: null }));
  assert.equal(slot.minutes, DEFAULT_DURATION_MINUTES);
  assert.equal(slot.endTime, '11:00');
});

test('日をまたぐ枠は、その日の終わりで止める（翌日を閉じない）', () => {
  // 23:00 JST 開始の3時間
  const slot = slotOf(row({ reserved_at: '2026-09-01T14:00:00.000Z', duration_minutes: 180 }));
  assert.equal(slot.startTime, '23:00');
  assert.equal(slot.endTime, '23:59');
});

test('ログ用の1行に顧客の氏名を入れない', () => {
  assert.equal(slotLabel(slotOf(row())), 'res=1 2026-09-01 10:00-11:00');
});

// ---- 駆動部の契約 ----

test('読み直せない駆動部は受け付けない', () => {
  assert.equal(isValidDriver(createNullDriver()), true);
  assert.equal(isValidDriver({ open() {}, close() {}, closeSlot() {}, openSlot() {} }), false);
  assert.equal(isValidDriver(null), false);
});

test('何もしない駆動部は「閉じた」と嘘をつかない', async () => {
  assert.equal(await createNullDriver().isSlotClosed({}), false);
});

// ---- 実行 ----

test('off では EPARK を一切触らない（既定）', async () => {
  const { sync, calls } = makeFakes({ toBlock: [row()], mode: 'off' });
  const summary = await sync.run();
  assert.equal(summary.skippedReason, 'off');
  assert.deepEqual(calls, []);
});

test('dry_run はログインして読むだけで、閉じない', async () => {
  const { sync, calls, done } = makeFakes({ toBlock: [row()], mode: 'dry_run' });

  const summary = await sync.run();

  assert.equal(summary.dryRun, 1);
  assert.equal(summary.done, 0);
  assert.deepEqual(calls.map((c) => c[0]), ['open', 'isSlotClosed', 'close']);
  assert.deepEqual(done, [], '済みにもしない');
});

test('閉じたあと読み直して、確認できたときだけ済みにする', async () => {
  const { sync, calls, done } = makeFakes({ toBlock: [row({ id: 5 })] });

  const summary = await sync.run();

  assert.equal(summary.done, 1);
  assert.deepEqual(calls, [['open'], ['closeSlot', 5], ['isSlotClosed', 5], ['close']]);
  assert.deepEqual(done, [{ id: 5, done: true }]);
});

test('取消の予約は開け直す。開いたことを確認して済みにする', async () => {
  const { sync, calls, done } = makeFakes({
    toRelease: [row({ id: 7, status: 'cancelled' })],
    driver: { async isSlotClosed() { return false; } },
  });

  const summary = await sync.run();

  assert.equal(summary.done, 1);
  assert.deepEqual(calls.map((c) => c[0]), ['open', 'openSlot', 'close']);
  assert.deepEqual(done, [{ id: 7, done: true }]);
});

test('閉じたつもりで閉じられていなければ、済みにせず失敗として残す', async () => {
  // これが自動化の一番怖い壊れ方。読み直しで検知する
  const { sync, done, notices } = makeFakes({
    toBlock: [row({ id: 5 })],
    driver: { async isSlotClosed() { return false; } },
  });

  const summary = await sync.run();

  assert.equal(summary.failed, 1);
  assert.equal(summary.done, 0);
  assert.deepEqual(done, [], 'チェックリストに残す');
  assert.match(notices[0], /EPARK 自動反映に失敗/);
  assert.match(notices[0], /res=5/);
});

test('1件失敗しても、残りの枠は閉じる', async () => {
  const { sync, done } = makeFakes({
    toBlock: [row({ id: 1 }), row({ id: 2 }), row({ id: 3 })],
    driver: {
      async closeSlot(s) { if (s.reservationId === 2) throw new Error('画面が開けません'); },
    },
  });

  const summary = await sync.run();

  assert.equal(summary.done, 2);
  assert.equal(summary.failed, 1);
  assert.deepEqual(done.map((d) => d.id), [1, 3]);
});

test('失敗の通知に顧客の氏名を入れない', async () => {
  const { sync, notices } = makeFakes({
    toBlock: [row({ id: 5, customer_name: '田中花子' })],
    driver: { async closeSlot() { throw new Error('失敗'); } },
  });

  await sync.run();

  assert.doesNotMatch(notices.join('\n'), /田中花子/);
});

test('途中で落ちてもログインしたままにしない', async () => {
  const { sync, calls } = makeFakes({
    toBlock: [row()],
    driver: { async isSlotClosed() { throw new Error('通信断'); } },
  });

  await sync.run();

  assert.equal(calls.at(-1)[0], 'close');
});

test('読み直せない駆動部では実行せず、通知して止まる', async () => {
  const notices = [];
  const done = [];
  const sync = createEparkSync({
    externalBlocks: {
      listPending: async () => ({ toBlock: [row()], toRelease: [] }),
      setDone: async (args) => { done.push(args); return { ok: true }; },
    },
    // isSlotClosed が無い＝閉じたことを確かめられない
    driver: { open() {}, close() {}, closeSlot() {}, openSlot() {} },
    slack: { notify: async () => {}, notifyError: async (c, e) => notices.push(`${c}: ${e.message}`) },
    config: { epark: { mode: 'live' } },
  });

  const summary = await sync.run();

  assert.equal(summary.skippedReason, 'invalid_driver');
  assert.deepEqual(done, []);
  assert.match(notices.join('\n'), /読み直しに対応していません/);
});

test('作業が無ければログインしない', async () => {
  const { sync, calls } = makeFakes({});
  const summary = await sync.run();
  assert.equal(summary.total, 0);
  assert.deepEqual(calls, []);
});

test('記録に失敗したら済みにしない（画面に残す）', async () => {
  const notices = [];
  const sync = createEparkSync({
    externalBlocks: {
      listPending: async () => ({ toBlock: [row({ id: 5 })], toRelease: [] }),
      setDone: async () => ({ ok: false, error: 'not_found' }),
    },
    driver: {
      async open() {}, async close() {}, async closeSlot() {}, async openSlot() {},
      async isSlotClosed() { return true; },
    },
    slack: { notify: async (t) => notices.push(t), notifyError: async () => {} },
    config: { epark: { mode: 'live' } },
  });

  const summary = await sync.run();

  assert.equal(summary.failed, 1);
  assert.match(notices.join('\n'), /not_found/);
});
