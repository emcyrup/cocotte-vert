// EPARK 管理画面（受付管理）の作り物。
//
// 実物にアクセスできないため、**実物からもらった HTML の作りを写して**駆動部を通す。
// 写したのは次の点。ここが同じなら、実物との差はセレクタの設定だけになる。
//
//   * ライン（トリミング申込 / ホテル宿泊申込）ごとの縦列
//   * 1時間刻みの行 id="id_1000"、枠のチェックボックス value="1000_1"
//   * 埋まっている枠は .reserveFrame1000_1、空き枠は .emptyFrame1000_1
//   * 仮受付には li.tentative-reservation が付く（本物のご予約には付かない）
//   * 閉じる＝チェック→「仮受付」、開ける＝チェック→「キャンセル」
//   * チェックボックスは CSS で隠され、見た目は <span class="box">（label を押す）
//   * 日付の移動は URL ではなく JavaScript（multiSchedulerCalendar）
//   * 枠は EPARK の受付番号（multiSchedulerHidAppointId）を持つ。1件ごとに違う
//   * **お名前を入れた枠には仮受付の印が付かない**（実物どおり）。見分けは受付番号で行う
//   * 空き枠の「受付」から顧客検索及び新規受付登録が開き、お名前と院内メモを添えて仮受付にできる
//     （「受付」ボタンは顧客を選ぶまで disabled、「仮受付」は押せる）
//
// わざと本物のご予約も1件置いてある。開け直しでそれに触らないことを確かめるため。

import http from 'node:http';

const TIMES = ['1000', '1100', '1200', '1300', '1400', '1500', '1600', '1700'];
const LINES = ['1', '2'];

const key = (date, time, line) => `${date} ${time} ${line}`;

/**
 * @param {object} p
 * @param {boolean} p.silentFail 押しても何も起きない画面を作る。
 *   実物は「仮受付」を押しても確認画面が出ないため、押せていないことに
 *   気付けるかを試す（自動化で一番怖い壊れ方）
 * @param {boolean} p.mismatchModal 受付登録の画面が、開いた枠とは別の時刻を名乗る。
 *   取り違えたまま押すと、まったく違う時間にご予約を入れてしまう
 */
export async function startFakeEpark({
  user = 'shop', password = 'pw', silentFail = false, mismatchModal = false,
} = {}) {
  // 埋まっている枠 → 'tentative'（自分が入れた仮受付） か 'booked'（本物のご予約）
  const filled = new Map();
  // 仮受付に添えられた院内メモ・お名前。実際に相手側へ届いたかを試す
  const memos = new Map();
  const names = new Map();
  // 枠ごとの EPARK 受付番号。実物と同じく1件ごとに増える
  const appointIds = new Map();
  let nextAppointId = 10000;
  let session = false;

  /** 枠を埋める。実物と同じく、埋めるたびに新しい受付番号が振られる */
  function fillCell(date, time, line, state) {
    filled.set(key(date, time, line), state);
    appointIds.set(key(date, time, line), String((nextAppointId += 1)));
  }

  function clearCell(date, time, line) {
    filled.delete(key(date, time, line));
    memos.delete(key(date, time, line));
    names.delete(key(date, time, line));
    appointIds.delete(key(date, time, line));
  }

  function schedulePage(date) {
    const rows = TIMES.map((t) => {
      const cells = LINES.map((line) => {
        const state = filled.get(key(date, t, line));
        const checkbox =
          `<div class="time-box"><label>` +
          `<input type="checkbox" name="appoint" value="${t}_${line}"><span class="box"></span>` +
          `</label></div>`;
        if (!state) {
          // 実物と同じく、空き枠の「受付」から顧客検索及び新規受付登録の画面が開く
          return `${checkbox}<div class="timetable-column line${line} inactive">
            <div class="reserve-content emptyFrame${t}_${line}">
              <ul class="info-list"><li class="reserve-link">
                <a href="/new?date=${date}&time=${t}&line=${line}">受付</a>
              </li></ul>
            </div></div>`;
        }
        // 実物どおり、**お名前が入っている枠には仮受付の印が付かない**。
        // 印だけを頼りにすると自分の枠を見失うので、受付番号で見分けられるかを試す
        const named = names.get(key(date, t, line));
        const mark = state !== 'tentative' || named
          ? `<li class="client-name"><span class="name">${named || 'ご予約'}</span></li>`
          : '<li class="tentative-reservation"><span class="name">仮受付</span></li>';
        return `${checkbox}<div class="timetable-column line${line} active">
          <div class="reserve-content reserveFrame${t}_${line}">
            <input type="hidden" name="multiSchedulerHidAppointId" value="${appointIds.get(key(date, t, line)) ?? ''}">
            <ul class="info-list">${mark}</ul>
          </div></div>`;
      }).join('');
      return `<div id="id_${t}" class="timetable-line">${cells}</div>`;
    }).join('');

    return `<!doctype html><meta charset="utf-8"><title>受付管理</title>
      <style>
        /* 実物と同じく、チェックボックスは隠して span を見た目に使う。
           input を直接押そうとすると時間切れになる（実物で踏んだ壊れ方） */
        input[name="appoint"] { position: absolute; opacity: 0; width: 0; height: 0; }
        .box { display: inline-block; width: 16px; height: 16px; border: 1px solid #999; }
      </style>
      <input type="hidden" id="multiSchedulerHidAppointDate" value="${date}">
      <div id="timetable">${rows}</div>
      <div id="multiple-select-panel">
        <div class="link tentative-reservation"><a href="javascript:void(0)" onclick="return apply('tentative')">仮受付</a></div>
        <div class="link cancel"><a href="javascript:void(0)" onclick="return apply('cancel')">キャンセル</a></div>
      </div>
      <script>
        // 実物と同じく、日付の移動は JavaScript の呼び出しでしかできない
        function multiSchedulerCalendar(d) { location.href = '/schedule?date=' + d; }
        function apply(what) {
          var picked = [].slice.call(document.querySelectorAll('input[name=appoint]:checked'))
            .map(function (el) { return el.value; });
          if (!picked.length) return false;
          location.href = '/apply?date=${date}&to=' + what + '&cells=' + picked.join(',');
          return false;
        }
      </script>`;
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (html) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    };
    const today = '20260901';

    if (url.pathname === '/login' && req.method === 'GET') {
      // 実物と同じく、送信は type="button" ＋ onclick（submit ではない）
      const failed = url.searchParams.get('ng')
        ? '<li>ログインIDまたはパスワードが違います。</li>' : '';
      return send(`<!doctype html><meta charset="utf-8">
        <div id="errorPop"><ul id="errorList">${failed}</ul></div>
        <form method="post" action="/login" id="loginForm">
          <input type="text" id="loginId" name="loginId">
          <input type="password" id="pwd" name="pwd">
        </form>
        <input name="login" type="button" class="Bloginbtn" value="ログイン"
               onclick="document.getElementById('loginForm').submit();">`);
    }
    if (url.pathname === '/login' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const form = new URLSearchParams(body);
        session = form.get('loginId') === user && form.get('pwd') === password;
        // 実物はログイン画面に留まってエラーを出す（別ページへは飛ばない）
        res.writeHead(302, { Location: session ? `/schedule?date=${today}` : '/login?ng=1' });
        res.end();
      });
      return undefined;
    }

    if (!session) return send('<!doctype html><meta charset="utf-8"><p class="error">ログインしてください</p>');

    if (url.pathname === '/schedule') {
      return send(schedulePage(url.searchParams.get('date') || today));
    }

    // 顧客検索及び新規受付登録。実物と同じく、開いた枠の日付・時刻・ラインを
    // hidden で持っている（別の枠の画面を掴んでいないかの確認に使う）
    if (url.pathname === '/new') {
      const date = url.searchParams.get('date');
      const time = url.searchParams.get('time');
      const line = url.searchParams.get('line');
      // 取り違えを作る。押す前に気付けるかを試す
      const shown = mismatchModal ? String(Number(time) - 100).padStart(4, '0') : time;
      return send(`<!doctype html><meta charset="utf-8"><title>受付登録</title>
        <div id="SearchCustomerAndRegisterAppoint">
          <input type="hidden" id="hidSearchCustomerAndRegisterAppointAppointDate" value="${date}">
          <input type="hidden" id="hidSearchCustomerAndRegisterAppointStartTime" value="${shown}">
          <input type="hidden" id="hidSearchCustomerAndRegisterAppointLineId" value="${line}">
          <form id="regForm" method="get" action="/apply">
            <input type="hidden" name="date" value="${date}">
            <input type="hidden" name="to" value="tentative">
            <input type="hidden" name="cells" value="${time}_${line}">
            <input id="searchCustomerAndRegisterAppointTxtLastName" name="lastName">
            <input id="searchCustomerAndRegisterAppointTxtFirstName" name="firstName">
            <input id="searchCustomerAndRegisterAppointTxtTel" name="tel">
            <textarea id="txtMemoNow" name="memo"></textarea>
            <textarea id="txtMemoNotice" name="notice"></textarea>
            <!-- 顧客を選ぶまで「受付」は押せない。「仮受付」は押せる（実物どおり） -->
            <input type="button" id="OP0062UD01" value="受付" disabled>
            <input type="button" id="OP0062UD02" value="仮受付"
                   onclick="document.getElementById('regForm').submit();">
          </form>
        </div>`);
    }

    if (url.pathname === '/apply') {
      const date = url.searchParams.get('date');
      const to = url.searchParams.get('to');
      const memo = url.searchParams.get('memo');
      const fullName = [url.searchParams.get('lastName'), url.searchParams.get('firstName')]
        .filter(Boolean).join(' ');
      for (const cell of (url.searchParams.get('cells') || '').split(',').filter(Boolean)) {
        if (silentFail) continue;   // 押しても何も起きない画面
        const [time, line] = cell.split('_');
        if (to === 'tentative') {
          fillCell(date, time, line, 'tentative');
          if (memo) memos.set(key(date, time, line), memo);
          if (fullName) names.set(key(date, time, line), fullName);
        } else {
          clearCell(date, time, line);
        }
      }
      res.writeHead(302, { Location: `/schedule?date=${date}` });
      return res.end();
    }

    res.writeHead(404).end('not found');
    return undefined;
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    base,
    filled,
    stateOf: (date, time, line) => filled.get(key(date, time, line)) ?? null,
    memoOf: (date, time, line) => memos.get(key(date, time, line)) ?? null,
    nameOf: (date, time, line) => names.get(key(date, time, line)) ?? null,
    appointIdOf: (date, time, line) => appointIds.get(key(date, time, line)) ?? null,
    setTentative: (date, time, line) => fillCell(date, time, line, 'tentative'),
    setBooked: (date, time, line) => fillCell(date, time, line, 'booked'),
    /** 枠の中身を別のものに差し替える（受付が消されて別の受付が入った状況を作る） */
    replaceWith: (date, time, line, state) => { clearCell(date, time, line); fillCell(date, time, line, state); },
    stop: () => new Promise((r) => server.close(r)),
    /** この作り物に合わせた画面設定。実物ではここだけが変わる */
    profile: {
      loginUrl: `${base}/login`,
      login: {
        user: '#loginId',
        password: '#pwd',
        submit: 'input.Bloginbtn',
        error: '#errorList li',
      },
      day: {
        url: `${base}/schedule?date=20260901`,
        script: "multiSchedulerCalendar('{dateCompact}')",
        ready: '#multiSchedulerHidAppointDate[value="{dateCompact}"]',
      },
      lines: [
        { id: '1', match: ['シャンプー', 'カット', '爪', '耳'] },
        { id: '2', match: ['宿泊', 'お泊まり'] },
      ],
      slotMinutes: 60,
      cell: {
        checkbox: 'label:has(input[name="appoint"][value="{timeCompact}_{line}"])',
        closed: '.reserveFrame{timeCompact}_{line}',
        open: '.emptyFrame{timeCompact}_{line}',
        ours: '.reserveFrame{timeCompact}_{line} li.tentative-reservation',
        appointId: '.reserveFrame{timeCompact}_{line} input[name="multiSchedulerHidAppointId"]',
      },
      close: [
        { click: '{checkbox}' },
        { click: '#multiple-select-panel .tentative-reservation a' },
        { waitFor: '{closed}' },
      ],
      open: [
        { click: '{checkbox}' },
        { click: '#multiple-select-panel .cancel a' },
        { waitFor: '{open}' },
      ],
      register: {
        open: '.emptyFrame{timeCompact}_{line} .reserve-link a',
        ready: '#SearchCustomerAndRegisterAppoint',
        verify: [
          '#hidSearchCustomerAndRegisterAppointAppointDate[value="{dateCompact}"]',
          '#hidSearchCustomerAndRegisterAppointStartTime[value="{timeCompact}"]',
          '#hidSearchCustomerAndRegisterAppointLineId[value="{line}"]',
        ],
        steps: [
          { fill: '#searchCustomerAndRegisterAppointTxtLastName', value: '{lastName}', optional: true },
          { fill: '#searchCustomerAndRegisterAppointTxtFirstName', value: '{firstName}', optional: true },
          { fill: '#searchCustomerAndRegisterAppointTxtTel', value: '{phone}', optional: true },
          { fill: '#txtMemoNow', value: '{details}' },
          { click: '#OP0062UD02' },
          { waitFor: '{closed}' },
        ],
      },
    },
  };
}
