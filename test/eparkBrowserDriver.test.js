// 駆動部を、作り物の管理画面に対して実際のブラウザで動かす。
//
// 実物の EPARK は見られないので、ここで確かめるのは**仕組み**:
// ログインできたか / 日付の画面を開けるか / 手順どおり押せるか /
// 書いたあと読み直して確かめられるか / 分からないときに黙って進まないか。
// 実物に合わせるのはセレクタの設定であって、この流れは変わらない。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserDriver } from '../src/epark/browserDriver.js';
import { startFakeEpark } from './fixtures/eparkFake.js';

// playwright は optionalDependencies。ブラウザが無い環境（CI など）では飛ばす
async function browserAvailable() {
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ executablePath: process.env.EPARK_BROWSER_PATH || undefined });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

const HAS_BROWSER = await browserAvailable();
const SLOT = { reservationId: 1, date: '2026-09-01', startTime: '11:00', endTime: '12:00', minutes: 60 };

// 失敗の確認で既定の30秒を待つと試験が長くなる。待ち時間だけ短くする
const FAST = { navTimeout: 3000, stepTimeout: 3000 };

function driverFor(fake, over = {}) {
  return createBrowserDriver({
    profile: { ...fake.profile, ...over },
    config: { epark: { user: 'shop', password: 'pw', browserPath: process.env.EPARK_BROWSER_PATH || null } },
    ...FAST,
  });
}

test('ログインして枠を閉じ、読み直して閉じたことを確かめられる', { skip: !HAS_BROWSER && 'ブラウザ未導入' }, async () => {
  const fake = await startFakeEpark();
  const driver = driverFor(fake);
  try {
    await driver.open();

    assert.equal(await driver.isSlotClosed(SLOT), false, 'はじめは開いている');
    await driver.closeSlot(SLOT);

    assert.equal(await driver.isSlotClosed(SLOT), true);
    assert.equal(fake.isClosed('2026-09-01', '11:00'), true, '作り物の側でも閉じている');
    assert.equal(fake.isClosed('2026-09-01', '10:00'), false, '隣の枠は触らない');
  } finally {
    await driver.close();
    await fake.stop();
  }
});

test('閉じた枠を開け直せる', { skip: !HAS_BROWSER && 'ブラウザ未導入' }, async () => {
  const fake = await startFakeEpark();
  fake.setClosed('2026-09-01', '11:00');
  const driver = driverFor(fake);
  try {
    await driver.open();
    assert.equal(await driver.isSlotClosed(SLOT), true);

    await driver.openSlot(SLOT);

    assert.equal(await driver.isSlotClosed(SLOT), false);
    assert.equal(fake.isClosed('2026-09-01', '11:00'), false);
  } finally {
    await driver.close();
    await fake.stop();
  }
});

test('枠が見つからないときは「閉じている」と解釈せず例外にする', { skip: !HAS_BROWSER && 'ブラウザ未導入' }, async () => {
  // 見つからない＝閉じた、と読むと、日付違いや画面変更を成功と誤読して消し込んでしまう
  const fake = await startFakeEpark();
  const driver = driverFor(fake);
  try {
    await driver.open();
    await assert.rejects(
      () => driver.isSlotClosed({ ...SLOT, startTime: '23:00' }),
      /枠が見つかりません/
    );
  } finally {
    await driver.close();
    await fake.stop();
  }
});

test('ログインできなければ、画面を操作せずに止まる', { skip: !HAS_BROWSER && 'ブラウザ未導入' }, async () => {
  const fake = await startFakeEpark();
  const driver = createBrowserDriver({
    profile: fake.profile,
    config: { epark: { user: 'shop', password: 'ちがう', browserPath: process.env.EPARK_BROWSER_PATH || null } },
    ...FAST,
  });
  try {
    await assert.rejects(() => driver.open(), /ログインできませんでした/);
    assert.equal(fake.closed.size, 0);
  } finally {
    await driver.close();
    await fake.stop();
  }
});

test('パスワードは例外の文言に出さない', { skip: !HAS_BROWSER && 'ブラウザ未導入' }, async () => {
  const fake = await startFakeEpark();
  const driver = createBrowserDriver({
    profile: fake.profile,
    config: { epark: { user: 'shop', password: 'ひみつの合言葉', browserPath: process.env.EPARK_BROWSER_PATH || null } },
    ...FAST,
  });
  try {
    const err = await driver.open().then(() => null, (e) => e);
    assert.ok(err);
    assert.doesNotMatch(err.stack || err.message, /ひみつの合言葉/);
  } finally {
    await driver.close();
    await fake.stop();
  }
});
