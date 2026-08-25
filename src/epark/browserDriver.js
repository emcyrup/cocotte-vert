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
//   * 空き枠から「顧客検索及び新規受付登録」を開くと、院内メモを添えて仮受付にできる。
//     開けるのは1枠ずつなので、お名前が載るのは**先頭の枠だけ**（残りは無名で押さえる）
//
// **本物のご予約には絶対に触らない。** 開け直すのは「自分が入れた仮受付」だけ。
// 見分けが付かない枠は例外にして、人に回す。
//
// playwright は optionalDependencies。EPARK を使わない環境・本番サーバーに
// ブラウザを置けない環境でもアプリが起動するよう、**使うときだけ動的に読む**。

import { fill, validateProfile, lineFor } from './profile.js';

const DEFAULT_NAV_TIMEOUT = 30_000;
const DEFAULT_STEP_TIMEOUT = 15_000;

/** 画面操作の例外は長い。通知に載るのは1行目だけで足りる */
function briefly(err) {
  return String(err?.message ?? err).split('\n')[0].slice(0, 160);
}

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
    const vars = { date: slot.date, dateCompact: slot.dateCompact ?? slot.date.replaceAll('-', '') };

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

  /**
   * 押せなかった押しどころが、どういう状態だったか。
   *
   * 「押せません」だけでは直しようがない。**画面に無い**なら設定が実物と違い、
   * **隠れている**なら見えている別の要素を押すべきで（チェックボックスで実際に踏んだ）、
   * **無効**なら手前の入力が足りていない。直し方がまるで違うので書き分ける。
   *
   * 状態しか見ない。要素の文言や値には、お客様の情報が入りうるため読まない。
   */
  async function clickBlockedBy(locator) {
    try {
      if ((await locator.count()) === 0) return '画面にありません';
      if (!(await locator.isVisible())) return '画面にはありますが隠れています';
      if (!(await locator.isEnabled())) return '押せない状態です（無効）';
      return '見えていて押せる状態なのに反応しません（何かが重なっている可能性）';
    } catch {
      // 状態を読むついでで転んでも、本来の失敗を握り潰さない
      return null;
    }
  }

  /**
   * 設定に書かれた手順を順に実行する。
   *
   * どこで転んだのかが分からないと直しようがないので、**手順の番号とセレクタを
   * 例外に載せる**。ただし打ち込む中身は載せない（お客様の情報が入りうるため、
   * fill / select では相手の例外文もそのまま持ち出さない）。
   *
   * `optional: true` の手順は、転んでも先へ進む。相手の画面が少し変わっても、
   * 入れられるところまでは入れたい欄に使う（例: お名前が入らなくても院内メモは入れる）。
   */
  async function runSteps(steps, vars) {
    // {closed} / {open} を使えるようにしておく。実物は「仮受付」を押しても確認画面が
    // 出ないため、**その枠が実際に変わるまで待つ**のが唯一の区切りになる
    const withSelectors = {
      ...vars,
      checkbox: cellSelector('checkbox', vars),
      closed: cellSelector('closed', vars),
      open: cellSelector('open', vars),
    };
    try {
      for (const [i, step] of steps.entries()) {
        const target = (sel) => page.locator(fill(sel, withSelectors)).first();
        // 打ち込む中身にも差し込みを効かせる（院内メモの {details} がこれで入る）
        const value = () => fill(String(step.value), withSelectors);
        const selector = step.click ?? step.fill ?? step.select ?? step.waitFor;
        try {
          if (step.click) await target(step.click).click({ timeout: stepTimeout });
          else if (step.fill) await target(step.fill).fill(value(), { timeout: stepTimeout });
          else if (step.select) await target(step.select).selectOption(value(), { timeout: stepTimeout });
          else if (step.waitFor) await target(step.waitFor).waitFor({ timeout: stepTimeout });
        } catch (err) {
          // 値を運ぶ手順は、相手の例外文に打ち込んだ中身が混じりうる。理由は伏せる
          const why = step.fill || step.select ? '打ち込めません' : briefly(err);
          // 待ち時間切れは「押せなかった」としか言わない。無いのか・隠れているのか・
          // 無効なのかで直し方がまるで違うので、押す手順のときだけ状態を添える。
          // 見るのは状態だけで、要素の中身（お名前が入りうる）は読まない
          const state = step.click ? await clickBlockedBy(target(step.click)) : null;
          const where = `手順${i + 1}（${selector}）: ${why}${state ? ` — ${state}` : ''}`;
          if (step.optional) {
            console.warn(`[epark] 飛ばしました ${where}`);
            continue;
          }
          throw new Error(where);
        }
      }
    } finally {
      // 保存のたびに受付表が作り替えられる。次は開き直す。
      // 途中で失敗したときも、チェックが入ったままの画面を使い回さないため必ず捨てる
      openedDate = null;
    }
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

  /**
   * その枠が持っている EPARK の受付番号。読めなければ null。
   * 閉じたあとに控えておき、開け直すときの本人確認に使う
   */
  async function cellAppointId(vars) {
    if (!profile.cell.appointId) return null;
    const field = page.locator(cellSelector('appointId', vars)).first();
    if ((await field.count()) === 0) return null;
    return (await field.getAttribute('value')) || null;
  }

  /**
   * その枠を埋めているのが「自分が入れたもの」か。本物のご予約なら false。
   *
   * 控えた受付番号があればそれで照合する。**顧客情報（お名前）を入れた枠は
   * 仮受付の印が付かなくなる**ため（実物で確認）、印より受付番号を優先する。
   * 番号は1件ごとに違うので、スタッフが手作業で入れた仮受付とも区別できる。
   *
   * 番号を控えていない枠（この仕組みより前に閉じたもの）は、従来どおり
   * 仮受付の印で見分ける。
   */
  async function cellIsOurs(vars, expectedId = null) {
    if (expectedId && profile.cell.appointId) {
      const actual = await cellAppointId(vars);
      return actual != null && String(actual) === String(expectedId);
    }
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
    // 押したあとに確認画面が出る操作がある（キャンセルなど）。Playwright は既定で
    // 「いいえ」を答えるため、押しても何も起きないまま待ち続けることになる。
    // こちらが起こした操作の確認なので受け入れる。効いたかどうかは、どのみち
    // 画面を読み直して確かめるので、ここで受け入れても勝手に進む心配はない。
    // 文面には氏名が混じりうるので、種類だけを残す
    page.on('dialog', (dialog) => {
      console.log(`[epark] 確認画面に「はい」で答えました（${dialog.type()}）`);
      dialog.accept().catch(() => {});
    });

    await page.goto(profile.loginUrl, { waitUntil: 'domcontentloaded', timeout: navTimeout });
    const loginUrl = page.url();
    await page.locator(profile.login.user).first().fill(config.epark.user);
    await page.locator(profile.login.password).first().fill(config.epark.password);
    // 実物の送信は type="button" ＋ onclick。submit ではないので押した後の遷移を自分で待つ
    await page.locator(profile.login.submit).first().click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});

    // 入力が違えば画面にエラーが出る。ここで気付けると原因が分かりやすい
    if (profile.login.error) {
      const failed = await page
        .locator(profile.login.error)
        .first()
        .waitFor({ state: 'visible', timeout: 3000 })
        .then(() => true, () => false);
      // パスワードは例外にも載せない
      if (failed) throw new Error('EPARK にログインできませんでした（ID かパスワードを確認してください）');
    }

    if (profile.login.ready) {
      try {
        await page.locator(profile.login.ready).first().waitFor({ state: 'attached', timeout: navTimeout });
      } catch {
        throw new Error('EPARK にログインできませんでした（画面設定 login.ready を確認してください）');
      }
    } else if (page.url() === loginUrl) {
      // ログイン画面に留まったまま＝入れていない。ここで止めないと、
      // ログインできていない画面を操作して見当違いの結果になる
      throw new Error('EPARK にログインできませんでした（ログイン画面から進んでいません）');
    }
    openedDate = null;
  }

  async function close() {
    if (browser) await browser.close();
    browser = null;
    page = null;
    openedDate = null;
  }

  /**
   * 空き枠から「顧客検索及び新規受付登録」を開き、お名前・電話番号・院内メモを
   * 入れて仮受付にする。
   *
   * 相手の顧客台帳は検索も選択もしない（`epark/details.js` 参照）。押すのは
   * 「受付」ではなく「仮受付」。正式な受付にすると取り消せなくなる。
   *
   * @returns {Promise<boolean>} 押せたら true。躓いたら false（呼び側が無名の仮受付に落とす）
   */
  async function registerCell(vars, fields) {
    const { register } = profile;
    // どこで転んだかを残す。**無名の仮受付に落ちても静かに落ちるので、
    // ログが無いと「なぜ名前が入らないのか」を追えない**（実物で一度これに詰まった）
    const gaveUp = (where) => {
      console.warn(`[epark] 登録画面を使えませんでした（${vars.date} ${vars.time}）: ${where}`);
      return false;
    };

    try {
      await page.locator(fill(register.open, vars)).first().click({ timeout: stepTimeout });
    } catch (err) {
      return gaveUp(`開けません（${register.open}）: ${briefly(err)}`);
    }
    try {
      await page.locator(fill(register.ready, vars)).first().waitFor({ timeout: stepTimeout });
    } catch (err) {
      return gaveUp(`開いたか確かめられません（${register.ready}）: ${briefly(err)}`);
    }
    // 開いた登録画面が別の枠のものだと、まったく違う時間にご予約を入れてしまう。
    // 画面が持っている日付・時刻・ラインを、閉じるつもりの枠と突き合わせる
    for (const selector of register.verify ?? []) {
      try {
        await page.locator(fill(selector, vars)).first().waitFor({ state: 'attached', timeout: stepTimeout });
      } catch (err) {
        return gaveUp(`別の枠の画面かもしれません（${selector}）: ${briefly(err)}`);
      }
    }

    try {
      await runSteps(register.steps, { ...vars, ...fields });
      return true;
    } catch (err) {
      // runSteps は手順の番号とセレクタだけを載せる（打ち込んだ中身は載せない）
      return gaveUp(err.message);
    }
  }

  /**
   * またがる枠を順に閉じる。すでに閉じている枠は飛ばす。
   *
   * **自分が実際に閉じた枠を、EPARK の受付番号つきで返す。** スタッフが手作業で
   * 止めていた枠をあとで勝手に開けないため、そして開け直すときに「その枠がまだ
   * 自分のものか」を1件単位で確かめるため。
   *
   * @param {object} slot
   * @param {{details:string,lastName:string,firstName:string,phone:string}|null} fields
   *   登録画面に打ち込む「誰のご予約か」。登録画面は1枠ずつしか開けないので、
   *   **最初の1枠にだけ**入れる。残りの枠は無名の仮受付で押さえる
   * @returns {Promise<{closed: Array<{time:string,id:string|null}>}>}
   */
  async function closeSlot(slot, fields = null) {
    const line = lineOf(slot);
    const closed = [];
    for (const time of slot.cells) {
      const vars = varsFor(slot, time, line);
      await gotoDay(slot);
      if (await cellClosed(vars)) continue;

      if (fields && profile.register && closed.length === 0) {
        await registerCell(vars, fields);
        // 登録画面を開いたまま／閉じたままの画面を使い回さない。必ず受付表に戻る。
        // **押せたかどうかは読み直しでしか分からない。** 実物では仮受付が入ったのに、
        // 入ったことを待ち構える手順のほうが時間切れになることがあった。
        // この枠は直前に「開」だと確かめてあるので、閉じていれば自分が閉じたもの
        await gotoDay(slot, { force: true });
        if (await cellClosed(vars)) {
          closed.push({ time, id: await cellAppointId(vars) });
          continue;
        }
        // 何も入らなかった。無名の仮受付に落として枠だけ押さえる
      }

      // 実物は「仮受付」を押しても確認画面が出ない。押せたかどうかは
      // **読み直して確かめるしかない**。閉じられていない枠を「自分が閉じた」と
      // 記録すると、取消のときにスタッフが止めていた枠を開けてしまう
      const failed = await runSteps(profile.close, vars).then(() => null, briefly);
      // 手順が途中で転んでも読み直す。書けていたのに失敗として残すと、
      // チェックリストに「もう閉じている枠」が並び続ける
      await gotoDay(slot, { force: true });
      if (await cellClosed(vars)) {
        closed.push({ time, id: await cellAppointId(vars) });
        continue;
      }
      throw new Error(`枠を閉じられませんでした（${slot.date} ${time}）${failed ? `: ${failed}` : ''}`);
    }
    return { closed };
  }

  /**
   * またがる枠を開け直す。
   * **自分が入れたものだけ**を戻す。本物のご予約が入っている枠には手を出さない
   * （こちらの取消と入れ違いで、EPARK からご予約が入っていることがある）。
   */
  async function openSlot(slot) {
    const line = lineOf(slot);
    // 「まだ自分の枠か」を古い画面で判断しない。ここが取り消しの唯一の歯止めなので、
    // 直前に読んだ画面を使い回さず必ず読み直す（2枠目以降は書き込みのたびに捨てられる）
    await gotoDay(slot, { force: true });
    for (const time of slot.cells) {
      const vars = varsFor(slot, time, line);
      await gotoDay(slot);
      if (!(await cellClosed(vars))) continue;
      // 閉じたときに控えた受付番号と照合する。番号が違えば、こちらの受付は
      // 消されていて別の受付が入っている＝触ってはいけない枠
      if (!(await cellIsOurs(vars, slot.cellIds?.[time]))) {
        throw new Error(`ご予約が入っている枠のため開けません（${slot.date} ${time}）`);
      }
      const before = await cellAppointId(vars);
      // 閉じるときと同じく、開いたことも読み直して確かめる（手順が転んでも読み直す）
      const failed = await runSteps(profile.open, vars).then(() => null, briefly);
      await gotoDay(slot, { force: true });
      if (!(await cellClosed(vars))) continue;
      // 受付番号が変わっていなければ、押したつもりで何も起きていない。
      // 確認画面を閉じられていない・押す場所が違う、を切り分けるための手がかり
      const after = await cellAppointId(vars);
      const hint = before != null && after != null && String(before) === String(after)
        ? '（受付はそのままです。押しても何も起きていません）'
        : '';
      throw new Error(
        `枠を開けられませんでした（${slot.date} ${time}）${hint}${failed ? `: ${failed}` : ''}`
      );
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

  /**
   * その日・そのラインの枠を読むだけ。**何も書き換えない。**
   * 設定が実物と合っているかを確かめるために使う（`scripts/epark-check.js`）。
   * 状態を読めない枠は例外にせず 'none'（枠なし）として返す。点検では全部見たいため。
   * @returns {Promise<Array<{time:string, state:'closed'|'open'|'none', ours:boolean}>>}
   */
  async function readDay({ date, lineId, times }) {
    const slot = { date, dateCompact: date.replaceAll('-', '') };
    await gotoDay(slot, { force: true });
    const rows = [];
    for (const time of times) {
      const vars = { ...slot, time, timeCompact: time.replace(':', ''), line: String(lineId) };
      const closed = await page.locator(cellSelector('closed', vars)).count();
      const isOpen = await page.locator(cellSelector('open', vars)).count();
      const state = closed > 0 && isOpen === 0 ? 'closed'
        : isOpen > 0 && closed === 0 ? 'open'
        : 'none';
      rows.push({
        time,
        state,
        ours: state === 'closed' ? await cellIsOurs(vars) : false,
        // 受付番号。お名前を載せた枠は仮受付の印が消えるので、点検ではこちらを見る
        id: state === 'closed' ? await cellAppointId(vars) : null,
      });
    }
    return rows;
  }

  return { open, close, closeSlot, openSlot, isSlotClosed, readDay, slotMinutes, lines: profile.lines };
}
