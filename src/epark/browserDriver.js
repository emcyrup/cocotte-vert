// EPARK 管理画面（受付管理）をブラウザで操作する駆動部。
//
// 押す場所は `profile.js` の設定から来る。ここには「どう押すか」だけを書き、
// 「どこを押すか」は持たない（相手の画面が変わってもコードを触らずに済ませる）。
//
// 実物の作りに合わせた要点:
//   * 枠を閉じる  … 枠のチェックボックスを入れて「仮受付」を押す
//   * 枠を開ける  … 同じチェックボックスを入れて「キャンセル」を押す
//   * 日付の移動  … URL ではなく画面の JavaScript を呼ぶ
//   * 1件の予約が複数の枠にまたがる（90分なら2枠）
//
// **本物のご予約には絶対に触らない。** 開け直すのは「自分が入れた仮受付」だけ。
// 見分けが付かない枠は例外にして、人に回す。
//
// playwright は optionalDependencies。EPARK を使わない環境・本番サーバーに
// ブラウザを置けない環境でもアプリが起動するよう、**使うときだけ動的に読む**。

import { fill, validateProfile, lineFor } from './profile.js';

const DEFAULT_NAV_TIMEOUT = 30_000;
const DEFAULT_STEP_TIMEOUT = 15_000;

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    throw new Error(
      'playwright が入っていません。EPARK の自動操作を行う環境で ' +
        '`npm install playwright && npx playwright install chromium` を実行してください'
    );
  }
}

export function createBrowserDriver({
  profile,
  config,
  launchOptions = {},
  navTimeout = DEFAULT_NAV_TIMEOUT,
  stepTimeout = DEFAULT_STEP_TIMEOUT,
}) {
  const check = validateProfile(profile);
  if (!check.ok) throw new Error(`EPARK の画面設定が不正です: ${check.error}`);

  const slotMinutes = profile.slotMinutes ?? 60;
  let browser = null;
  let page = null;
  let openedDate = null;

  /** その予約をどのラインの枠で押さえるか */
  function lineOf(slot) {
    const line = lineFor(slot.menu, profile.lines);
    if (!line) {
      // 取り違えて別のラインを閉じるより、人に回すほうが安い
      throw new Error(`どのラインの枠か決められません（コース: ${slot.menu || '未設定'}）`);
    }
    return line;
  }

  function varsFor(slot, time, line) {
    return {
      date: slot.date,
      dateCompact: slot.dateCompact,
      time,
      timeCompact: time.replace(':', ''),
      line: String(line.id),
    };
  }

  const cellSelector = (key, vars) => fill(profile.cell[key], vars);

  /** その日の受付表を開く。force のときは開き直す（書き込み後の読み直しに使う） */
  async function gotoDay(slot, { force = false } = {}) {
    if (!force && openedDate === slot.date) return;
    const vars = { date: slot.date, dateCompact: slot.dateCompact };

    await page.goto(fill(profile.day.url, vars), {
      waitUntil: 'domcontentloaded',
      timeout: navTimeout,
    });
    if (profile.day.script) {
      // 日付の移動が画面の JavaScript でしかできない作りのため、その関数を呼ぶ
      await page.evaluate(fill(profile.day.script, vars));
    }
    try {
      // 日付の目印は hidden input のことが多い（実物もそう）。見えていなくても良い
      await page
        .locator(fill(profile.day.ready, vars))
        .first()
        .waitFor({ state: 'attached', timeout: navTimeout });
    } catch {
      // 開けた日付を確かめられないまま操作すると、別の日の枠を閉じかねない
      throw new Error(`${slot.date} の受付表を開けませんでした（day.ready を確認してください）`);
    }
    openedDate = slot.date;
  }

  /** 設定に書かれた手順を順に実行する */
  async function runSteps(steps, vars) {
    const withCheckbox = { ...vars, checkbox: cellSelector('checkbox', vars) };
    for (const step of steps) {
      const target = (sel) => page.locator(fill(sel, withCheckbox)).first();
      if (step.click) await target(step.click).click({ timeout: stepTimeout });
      else if (step.fill) await target(step.fill).fill(String(step.value), { timeout: stepTimeout });
      else if (step.select) await target(step.select).selectOption(String(step.value), { timeout: stepTimeout });
      else if (step.waitFor) await target(step.waitFor).waitFor({ timeout: stepTimeout });
    }
    // 保存のたびに受付表が作り替えられる。次は開き直す
    openedDate = null;
  }

  /**
   * 1つの枠がいま閉じているか。
   * 「閉」でも「開」でも無い＝画面が読めていないので**例外にする**。
   * 見つからないものを閉じている扱いにすると、失敗を成功と誤読して消し込んでしまう。
   */
  async function cellClosed(vars) {
    const closed = await page.locator(cellSelector('closed', vars)).count();
    const open = await page.locator(cellSelector('open', vars)).count();
    if (closed > 0 && open === 0) return true;
    if (open > 0 && closed === 0) return false;
    throw new Error(`枠の状態を読めません（${vars.date} ${vars.time} line=${vars.line}）`);
  }

  /** その枠を埋めているのが「自分が入れた仮受付」か。本物のご予約なら false */
  async function cellIsOurs(vars) {
    return (await page.locator(cellSelector('ours', vars)).count()) > 0;
  }

  async function open() {
    const { chromium } = await loadPlaywright();
    browser = await chromium.launch({
      // 本番サーバーに置けないときのため、実行ファイルの場所を差し替えられるようにする
      executablePath: config.epark.browserPath || undefined,
      ...launchOptions,
    });
    page = await browser.newPage();
    page.setDefaultTimeout(stepTimeout);

    await page.goto(profile.loginUrl, { waitUntil: 'domcontentloaded', timeout: navTimeout });
    await page.locator(profile.login.user).first().fill(config.epark.user);
    await page.locator(profile.login.password).first().fill(config.epark.password);
    await page.locator(profile.login.submit).first().click();
    try {
      await page.locator(profile.login.ready).first().waitFor({ timeout: navTimeout });
    } catch {
      // ここで止めないと、ログインできていない画面を操作して見当違いの結果になる。
      // パスワードは例外にも載せない
      throw new Error('EPARK にログインできませんでした（画面設定 login.ready を確認してください）');
    }
    openedDate = null;
  }

  async function close() {
    if (browser) await browser.close();
    browser = null;
    page = null;
    openedDate = null;
  }

  /** またがる枠を順に閉じる。すでに閉じている枠は飛ばす */
  async function closeSlot(slot) {
    const line = lineOf(slot);
    for (const time of slot.cells) {
      const vars = varsFor(slot, time, line);
      await gotoDay(slot);
      if (await cellClosed(vars)) continue;
      await runSteps(profile.close, vars);
    }
  }

  /**
   * またがる枠を開け直す。
   * **自分が入れた仮受付だけ**を戻す。本物のご予約が入っている枠には手を出さない
   * （こちらの取消と入れ違いで、EPARK からご予約が入っていることがある）。
   */
  async function openSlot(slot) {
    const line = lineOf(slot);
    for (const time of slot.cells) {
      const vars = varsFor(slot, time, line);
      await gotoDay(slot);
      if (!(await cellClosed(vars))) continue;
      if (!(await cellIsOurs(vars))) {
        throw new Error(`ご予約が入っている枠のため開けません（${slot.date} ${time}）`);
      }
      await runSteps(profile.open, vars);
    }
  }

  /** またがる枠が「全部閉じている」ときだけ閉じたとみなす */
  async function isSlotClosed(slot) {
    const line = lineOf(slot);
    await gotoDay(slot, { force: true });
    for (const time of slot.cells) {
      if (!(await cellClosed(varsFor(slot, time, line)))) return false;
    }
    return true;
  }

  return { open, close, closeSlot, openSlot, isSlotClosed, slotMinutes };
}
