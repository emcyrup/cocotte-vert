// 駆動部を、作り物の受付管理に対して実際のブラウザで動かす。
//
// 作り物は実物からもらった HTML の作りを写してある（ライン・1時間枠・仮受付の印・
// チェックして「仮受付」/「キャンセル」・日付移動が JavaScript）。ここが通れば、
// 実物との差はセレクタの設定だけになる。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserDriver } from '../src/epark/browserDriver.js';
import { slotOf } from '../src/epark/slot.js';
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
const skip = !HAS_BROWSER && 'ブラウザ未導入';
// 失敗の確認で既定の30秒を待つと試験が長くなる。待ち時間だけ短くする
const FAST = { navTimeout: 4000, stepTimeout: 4000 };

// 2026-09-01 10:00 JST = 01:00 UTC
const at = (hour, minutes = 60, menu = 'シャンプーコース') => slotOf({
  id: 1,
  reserved_at: `2026-09-01T${String(hour - 9).padStart(2, '0')}:00:00.000Z`,
  menu,
  duration_minutes: minutes,
});

function driverFor(fake, over = {}) {
  return createBrowserDriver({
    profile: { ...fake.profile, ...over },
    config: { epark: { user: 'shop', password: 'pw', browserPath: process.env.EPARK_BROWSER_PATH || null } },
    ...FAST,
  });
}

async function withDriver(fake, fn, over = {}) {
  const driver = driverFor(fake, over);
  try {
    await driver.open();
    await fn(driver);
  } finally {
    await driver.close();
    await fake.stop();
  }
}

test('ログインして枠を閉じ、読み直して閉じたことを確かめられる', { skip }, async () => {
  const fake = await startFakeEpark();
  await withDriver(fake, async (driver) => {
    const slot = at(11);
    assert.equal(await driver.isSlotClosed(slot), false, 'はじめは開いている');

    await driver.closeSlot(slot);

    assert.equal(await driver.isSlotClosed(slot), true);
    assert.equal(fake.stateOf('20260901', '1100', '1'), 'tentative');
    assert.equal(fake.stateOf('20260901', '1000', '1'), null, '隣の枠は触らない');
    assert.equal(fake.stateOf('20260901', '1100', '2'), null, '別のラインは触らない');
  });
});

test('90分の予約は、またがる2枠とも閉じる', { skip }, async () => {
  // 1枠しか閉じないと、はみ出した時間に別のお客様が入れてしまう
  const fake = await startFakeEpark();
  await withDriver(fake, async (driver) => {
    const slot = at(11, 90);
    assert.deepEqual(slot.cells, ['11:00', '12:00']);

    await driver.closeSlot(slot);

    assert.equal(fake.stateOf('20260901', '1100', '1'), 'tentative');
    assert.equal(fake.stateOf('20260901', '1200', '1'), 'tentative');
    assert.equal(await driver.isSlotClosed(slot), true);
  });
});

test('またがる枠が1つでも開いていれば「閉じた」とみなさない', { skip }, async () => {
  const fake = await startFakeEpark();
  fake.setTentative('20260901', '1100', '1');
  await withDriver(fake, async (driver) => {
    assert.equal(await driver.isSlotClosed(at(11, 90)), false);
  });
});

test('コースの名前でラインを選ぶ（宿泊はホテルの列）', { skip }, async () => {
  const fake = await startFakeEpark();
  await withDriver(fake, async (driver) => {
    await driver.closeSlot(at(13, 60, '宿泊（レギュラーコース）'));

    assert.equal(fake.stateOf('20260901', '1300', '2'), 'tentative');
    assert.equal(fake.stateOf('20260901', '1300', '1'), null);
  });
});

test('どのラインか決められないコースは、勝手に閉じずに止まる', { skip }, async () => {
  const fake = await startFakeEpark();
  await withDriver(fake, async (driver) => {
    await assert.rejects(
      () => driver.closeSlot(at(13, 60, '未知のなにか')),
      /どのラインの枠か決められません/
    );
    assert.equal(fake.filled.size, 0);
  });
});

test('自分が入れた仮受付は開け直せる', { skip }, async () => {
  const fake = await startFakeEpark();
  fake.setTentative('20260901', '1100', '1');
  await withDriver(fake, async (driver) => {
    const slot = at(11);
    assert.equal(await driver.isSlotClosed(slot), true);

    await driver.openSlot(slot);

    assert.equal(await driver.isSlotClosed(slot), false);
    assert.equal(fake.stateOf('20260901', '1100', '1'), null);
  });
});

test('本物のご予約が入っている枠は開けない', { skip }, async () => {
  // こちらの取消と入れ違いで EPARK からご予約が入っていることがある。
  // 仮受付と同じ扱いで消すと、お客様のご予約を消してしまう
  const fake = await startFakeEpark();
  fake.setBooked('20260901', '1100', '1');
  await withDriver(fake, async (driver) => {
    await assert.rejects(() => driver.openSlot(at(11)), /ご予約が入っている枠のため開けません/);
    assert.equal(fake.stateOf('20260901', '1100', '1'), 'booked', '消していない');
  });
});

test('別の日付の受付表へ移れる（移動は画面の JavaScript）', { skip }, async () => {
  const fake = await startFakeEpark();
  await withDriver(fake, async (driver) => {
    const slot = slotOf({ id: 2, reserved_at: '2026-09-03T01:00:00.000Z', menu: 'カット', duration_minutes: 60 });
    await driver.closeSlot(slot);

    assert.equal(fake.stateOf('20260903', '1000', '1'), 'tentative');
    assert.equal(fake.stateOf('20260901', '1000', '1'), null, '開いていた日の枠は触らない');
  });
});

test('日付が変わったことを確かめられなければ操作しない', { skip }, async () => {
  const fake = await startFakeEpark();
  await withDriver(fake, async (driver) => {
    await assert.rejects(() => driver.closeSlot(at(11)), /受付表を開けませんでした/);
    assert.equal(fake.filled.size, 0);
  }, { day: { ...fake.profile.day, ready: '#thereIsNoSuchThing' } });
});

test('枠そのものが無い時刻は、閉じているとみなさず例外にする', { skip }, async () => {
  // 見つからない＝閉じている、と読むと、画面の変更を成功と誤読して消し込んでしまう
  const fake = await startFakeEpark();
  await withDriver(fake, async (driver) => {
    await assert.rejects(() => driver.isSlotClosed(at(23)), /枠の状態を読めません/);
  });
});

test('閉じた枠だけを返す（すでに閉じていた枠は自分のものにしない）', { skip }, async () => {
  // スタッフが手で止めていた枠を、あとで取消のときに勝手に開けてしまわないため
  const fake = await startFakeEpark();
  fake.setTentative('20260901', '1100', '1');
  await withDriver(fake, async (driver) => {
    const { closed } = await driver.closeSlot(at(11, 120));
    assert.deepEqual(closed.map((c) => c.time), ['12:00'], '自分が閉じたのは12:00だけ');
    assert.equal(closed[0].id, fake.appointIdOf('20260901', '1200', '1'), '受付番号も控える');
  });
});

test('開け直すのは渡された枠だけ（スタッフが止めた枠は残す）', { skip }, async () => {
  const fake = await startFakeEpark();
  fake.setTentative('20260901', '1100', '1');   // スタッフが手で止めた枠
  fake.setTentative('20260901', '1200', '1');   // 自分が閉じた枠
  await withDriver(fake, async (driver) => {
    // 自分が閉じた枠だけを cells に入れて渡す（sync が記録から作る）
    await driver.openSlot({ ...at(11, 120), cells: ['12:00'] });

    assert.equal(fake.stateOf('20260901', '1100', '1'), 'tentative', 'スタッフの枠は残す');
    assert.equal(fake.stateOf('20260901', '1200', '1'), null);
  });
});

test('押しても何も起きない画面では、閉じたことにしない', { skip }, async () => {
  // 実物は「仮受付」を押しても確認画面が出ない。押せていないことに気付けるのは
  // 読み直しだけで、ここを外すと「閉じたつもり」で消し込んでしまう
  const fake = await startFakeEpark({ silentFail: true });
  await withDriver(fake, async (driver) => {
    await assert.rejects(() => driver.closeSlot(at(11)), /枠を閉じられませんでした/);
    assert.equal(fake.filled.size, 0);
  });
});

test('開けたつもりで開いていなければ、済みにしない', { skip }, async () => {
  const fake = await startFakeEpark({ silentFail: true });
  fake.setTentative('20260901', '1100', '1');
  await withDriver(fake, async (driver) => {
    await assert.rejects(() => driver.openSlot(at(11)), /枠を開けられませんでした/);
    assert.equal(fake.stateOf('20260901', '1100', '1'), 'tentative');
  });
});

test('ログインできなければ、画面を操作せずに止まる', { skip }, async () => {
  const fake = await startFakeEpark();
  const driver = createBrowserDriver({
    profile: fake.profile,
    config: { epark: { user: 'shop', password: 'ちがう', browserPath: process.env.EPARK_BROWSER_PATH || null } },
    ...FAST,
  });
  try {
    await assert.rejects(() => driver.open(), /ログインできませんでした/);
    assert.equal(fake.filled.size, 0);
  } finally {
    await driver.close();
    await fake.stop();
  }
});

test('パスワードは例外の文言に出さない', { skip }, async () => {
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

// ---- 仮受付にお名前を載せる（顧客検索及び新規受付登録） ----

const DETAILS = 'LINE予約 / 山田 花子 様 / ポチちゃん / 090-1234-5678 / カット / res=1';
const FIELDS = { details: DETAILS, lastName: '山田', firstName: '花子', phone: '09012345678' };

test('お名前を渡すと、登録画面の院内メモに入れて仮受付にする', { skip }, async () => {
  const fake = await startFakeEpark();
  await withDriver(fake, async (driver) => {
    const slot = at(11);
    assert.deepEqual(await driver.closeSlot(slot, FIELDS), { closed: [{ time: '11:00', id: fake.appointIdOf('20260901','1100','1') }] });
    assert.equal(fake.stateOf('20260901', '1100', '1'), 'tentative');
    assert.equal(fake.memoOf('20260901', '1100', '1'), DETAILS);
  });
});

test('またがる枠は先頭だけお名前付き。残りは無名で押さえる', { skip }, async () => {
  const fake = await startFakeEpark();
  await withDriver(fake, async (driver) => {
    const slot = at(11, 90);
    assert.deepEqual(await driver.closeSlot(slot, FIELDS), { closed: ['11:00','12:00'].map((t) => ({ time: t, id: fake.appointIdOf('20260901', t.replace(':',''), '1') })) });
    assert.equal(fake.memoOf('20260901', '1100', '1'), DETAILS);
    // 登録画面は1枠ずつしか開けない。2枠目は従来どおりの一括仮受付
    assert.equal(fake.memoOf('20260901', '1200', '1'), null);
    assert.equal(fake.stateOf('20260901', '1200', '1'), 'tentative');
  });
});

test('お名前を渡さなければ、これまでどおり無名の仮受付になる', { skip }, async () => {
  const fake = await startFakeEpark();
  await withDriver(fake, async (driver) => {
    assert.deepEqual(await driver.closeSlot(at(11)), { closed: [{ time: '11:00', id: fake.appointIdOf('20260901','1100','1') }] });
    assert.equal(fake.memoOf('20260901', '1100', '1'), null);
  });
});

test('別の枠の登録画面が開いたら、そこには書き込まず従来の手順に落とす', { skip }, async () => {
  // 開いた登録画面が、頼んだ枠とは別の時刻を名乗る
  const fake = await startFakeEpark({ mismatchModal: true });
  await withDriver(fake, async (driver) => {
    assert.deepEqual(await driver.closeSlot(at(12), FIELDS), { closed: [{ time: '12:00', id: fake.appointIdOf('20260901','1200','1') }] });
    // 押す前に気付いて引き返す。お名前は載らないが、頼まれた枠は押さえる
    assert.equal(fake.stateOf('20260901', '1200', '1'), 'tentative');
    assert.equal(fake.memoOf('20260901', '1200', '1'), null);
    // 名乗っていたほうの枠にも、何も書き込まない
    assert.equal(fake.stateOf('20260901', '1100', '1'), null);
  });
});

test('登録画面が開かなくても、枠だけは押さえる', { skip }, async () => {
  const fake = await startFakeEpark();
  const register = { ...fake.profile.register, open: '.emptyFrame{timeCompact}_{line} .nowhere a' };
  await withDriver(fake, async (driver) => {
    assert.deepEqual(await driver.closeSlot(at(11), FIELDS), { closed: [{ time: '11:00', id: fake.appointIdOf('20260901','1100','1') }] });
    assert.equal(fake.stateOf('20260901', '1100', '1'), 'tentative');
  }, { register });
});

test('お名前を載せた枠は、控えた受付番号で開け直せる', { skip }, async () => {
  const fake = await startFakeEpark();
  await withDriver(fake, async (driver) => {
    const slot = at(11);
    const { closed } = await driver.closeSlot(slot, FIELDS);

    // 実物どおり、お名前が入ると仮受付の印は消える。それでも開け直せることが要
    assert.equal(fake.nameOf('20260901', '1100', '1'), '山田 花子', '受付表の一覧に名前が出る');
    assert.deepEqual(await driver.readDay({ date: '2026-09-01', lineId: '1', times: ['11:00'] }),
      [{ time: '11:00', state: 'closed', ours: false, id: closed[0].id }],
      '仮受付の印は無いが、受付番号は読める');

    await driver.openSlot({ ...slot, cellIds: { '11:00': closed[0].id } });
    assert.equal(fake.stateOf('20260901', '1100', '1'), null);
  });
});

test('控えた受付番号と違う枠には手を出さない', { skip }, async () => {
  const fake = await startFakeEpark();
  await withDriver(fake, async (driver) => {
    const slot = at(11);
    const { closed } = await driver.closeSlot(slot, FIELDS);
    // こちらの受付が消され、別の受付が入った状況（番号が変わる）
    fake.replaceWith('20260901', '1100', '1', 'tentative');

    await assert.rejects(
      () => driver.openSlot({ ...slot, cellIds: { '11:00': closed[0].id } }),
      /ご予約が入っている枠のため開けません/
    );
    assert.equal(fake.stateOf('20260901', '1100', '1'), 'tentative', '他人の枠は残る');
  });
});

test('受付番号を控えていない枠は、これまでどおり仮受付の印で見分ける', { skip }, async () => {
  const fake = await startFakeEpark();
  await withDriver(fake, async (driver) => {
    const slot = at(11);
    await driver.closeSlot(slot);          // 無名なので仮受付の印が付く
    await driver.openSlot(slot);           // cellIds なし
    assert.equal(fake.stateOf('20260901', '1100', '1'), null);
  });
});

test('お名前は例外の文言に出さない', { skip }, async () => {
  const fake = await startFakeEpark({ silentFail: true });
  await withDriver(fake, async (driver) => {
    const err = await driver.closeSlot(at(11), FIELDS).then(() => null, (e) => e);
    assert.ok(err);
    assert.doesNotMatch(err.stack || err.message, /山田 花子|090-1234-5678|ポチ/);
  });
});

test('隠れているチェックボックスでも押せる（label を押す）', { skip }, async () => {
  const fake = await startFakeEpark();
  await withDriver(fake, async (driver) => {
    // 実物の input は CSS で隠れている。直接押すと時間切れになるので label を押す
    assert.deepEqual(await driver.closeSlot(at(13)), { closed: [{ time: '13:00', id: fake.appointIdOf('20260901','1300','1') }] });
    assert.equal(fake.stateOf('20260901', '1300', '1'), 'tentative');
  });
});

test('押した手順が転んでも、実際に閉じていれば済みにする', { skip }, async () => {
  const fake = await startFakeEpark();
  // 「仮受付」は押せるが、そのあと待ち構えるところが当たらない設定
  const close = [
    { click: '{checkbox}' },
    { click: '#multiple-select-panel .tentative-reservation a' },
    { waitFor: '.never-appears' },
  ];
  await withDriver(fake, async (driver) => {
    assert.deepEqual(await driver.closeSlot(at(13)), { closed: [{ time: '13:00', id: fake.appointIdOf('20260901','1300','1') }] });
    assert.equal(fake.stateOf('20260901', '1300', '1'), 'tentative');
  }, { close });
});

test('顧客情報の欄が入らなくても、院内メモまでは進む', { skip }, async () => {
  const fake = await startFakeEpark();
  // 実物の画面が変わってお名前の欄が見つからない状況
  const register = {
    ...fake.profile.register,
    steps: [
      { fill: '#nowhere-lastname', value: '{lastName}', optional: true },
      { fill: '#txtMemoNow', value: '{details}' },
      { click: '#OP0062UD02' },
      { waitFor: '{closed}' },
    ],
  };
  await withDriver(fake, async (driver) => {
    const { closed } = await driver.closeSlot(at(11), FIELDS);
    assert.equal(closed.length, 1);
    assert.equal(fake.memoOf('20260901', '1100', '1'), DETAILS, '名前は入らないがメモは入る');
    assert.equal(fake.nameOf('20260901', '1100', '1'), null);
  }, { register });
});

test('登録画面で転んだ場所をログに残す（中身は出さない）', { skip }, async () => {
  const fake = await startFakeEpark();
  const register = {
    ...fake.profile.register,
    steps: [{ fill: '#nowhere-memo', value: '{details}' }, { click: '#OP0062UD02' }],
  };
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    await withDriver(fake, async (driver) => {
      await driver.closeSlot(at(11), FIELDS);   // 無名の仮受付に落ちる
    }, { register });
  } finally {
    console.warn = warn;
  }
  const line = warnings.find((w) => w.includes('登録画面を使えませんでした'));
  assert.ok(line, `どこで転んだかを残す: ${warnings.join(' / ')}`);
  assert.match(line, /#nowhere-memo/, 'セレクタは出す');
  assert.doesNotMatch(line, /山田 花子|090-1234-5678/, '打ち込む中身は出さない');
});
