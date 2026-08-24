// EPARK 管理画面をブラウザで操作する駆動部。
//
// 押す場所は `profile.js` の設定から来る。ここには「どう押すか」だけを書き、
// 「どこを押すか」は持たない（相手の画面が変わってもコードを触らずに済ませる）。
//
// playwright は optionalDependencies。EPARK を使わない環境・本番サーバーに
// ブラウザを置けない環境でもアプリが起動するよう、**使うときだけ動的に読む**。

import { fill, validateProfile } from './profile.js';

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

/**
 * @param {object} p
 * @param {object} p.profile   画面の設定（validateProfile を通ったもの）
 * @param {object} p.config    loadConfig() の結果（epark.user / epark.password を使う）
 */
export function createBrowserDriver({
  profile,
  config,
  launchOptions = {},
  navTimeout = DEFAULT_NAV_TIMEOUT,
  stepTimeout = DEFAULT_STEP_TIMEOUT,
}) {
  const check = validateProfile(profile);
  if (!check.ok) throw new Error(`EPARK の画面設定が不正です: ${check.error}`);
  const NAV_TIMEOUT = navTimeout;
  const STEP_TIMEOUT = stepTimeout;

  let browser = null;
  let page = null;
  // いま開いている日付。同じ日の枠が続くときに読み込み直さないため
  let openedDate = null;

  function slotSelector(slot) {
    return fill(profile.slot, { date: slot.date, time: slot.startTime });
  }

  /** その日の画面を開く。force のときは開き直す（書き込み後の読み直しに使う） */
  async function gotoDay(slot, { force = false } = {}) {
    if (!force && openedDate === slot.date) return;
    await page.goto(fill(profile.dayUrl, { date: slot.date }), {
      waitUntil: 'domcontentloaded',
      timeout: NAV_TIMEOUT,
    });
    openedDate = slot.date;
  }

  /** 設定に書かれた手順を順に実行する */
  async function runSteps(steps, slot) {
    const vars = { slot: slotSelector(slot), date: slot.date, time: slot.startTime };
    for (const step of steps) {
      if (step.click) await page.locator(fill(step.click, vars)).first().click({ timeout: STEP_TIMEOUT });
      else if (step.fill) await page.locator(fill(step.fill, vars)).first().fill(String(step.value), { timeout: STEP_TIMEOUT });
      else if (step.select) await page.locator(fill(step.select, vars)).first().selectOption(String(step.value), { timeout: STEP_TIMEOUT });
      else if (step.waitFor) await page.locator(fill(step.waitFor, vars)).first().waitFor({ timeout: STEP_TIMEOUT });
    }
    // 手順の途中で保存され、画面が作り替わっていることがある。次は開き直す
    openedDate = null;
  }

  async function open() {
    const { chromium } = await loadPlaywright();
    browser = await chromium.launch({
      // 本番サーバーに置けないときのため、実行ファイルの場所を差し替えられるようにする
      executablePath: config.epark.browserPath || undefined,
      ...launchOptions,
    });
    page = await browser.newPage();
    page.setDefaultTimeout(STEP_TIMEOUT);

    await page.goto(profile.loginUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await page.locator(profile.login.user).first().fill(config.epark.user);
    await page.locator(profile.login.password).first().fill(config.epark.password);
    await page.locator(profile.login.submit).first().click();
    try {
      await page.locator(profile.login.ready).first().waitFor({ timeout: NAV_TIMEOUT });
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

  async function closeSlot(slot) {
    await gotoDay(slot);
    await runSteps(profile.close, slot);
  }

  async function openSlot(slot) {
    await gotoDay(slot);
    await runSteps(profile.open, slot);
  }

  /**
   * いま閉じているかを画面から読み直す。
   *
   * **枠そのものが見つからないときは例外にする。** 「見つからない＝閉じている」と
   * 解釈すると、日付を間違えた・画面が変わったといった失敗を「閉じられた」と
   * 誤読して消し込んでしまう。分からないときは分からないと言う。
   */
  async function isSlotClosed(slot) {
    await gotoDay(slot, { force: true });
    const target = page.locator(slotSelector(slot)).first();
    if ((await target.count()) === 0) {
      throw new Error(`枠が見つかりません（${slot.date} ${slot.startTime}）`);
    }
    // closedWhen は枠のセレクタに継ぎ足す。枠そのものに印が付くなら ".is-closed"、
    // 中の要素で表すなら " .badge-closed" のように先頭に空白を置く（CSS の子孫セレクタ）
    return (await page.locator(`${slotSelector(slot)}${profile.closedWhen}`).count()) > 0;
  }

  return { open, close, closeSlot, openSlot, isSlotClosed };
}
