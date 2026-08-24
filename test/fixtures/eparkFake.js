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
//   * 日付の移動は URL ではなく JavaScript（multiSchedulerCalendar）
//
// わざと本物のご予約も1件置いてある。開け直しでそれに触らないことを確かめるため。

import http from 'node:http';

const TIMES = ['1000', '1100', '1200', '1300', '1400', '1500', '1600', '1700'];
const LINES = ['1', '2'];

const key = (date, time, line) => `${date} ${time} ${line}`;

export async function startFakeEpark({ user = 'shop', password = 'pw' } = {}) {
  // 埋まっている枠 → 'tentative'（自分が入れた仮受付） か 'booked'（本物のご予約）
  const filled = new Map();
  let session = false;

  function schedulePage(date) {
    const rows = TIMES.map((t) => {
      const cells = LINES.map((line) => {
        const state = filled.get(key(date, t, line));
        const checkbox =
          `<div class="time-box"><label>` +
          `<input type="checkbox" name="appoint" value="${t}_${line}"><span class="box"></span>` +
          `</label></div>`;
        if (!state) {
          return `${checkbox}<div class="timetable-column line${line} inactive">
            <div class="reserve-content emptyFrame${t}_${line}">
              <ul class="info-list"><li class="reserve-link"><a href="#">受付</a></li></ul>
            </div></div>`;
        }
        const mark = state === 'tentative'
          ? '<li class="tentative-reservation"><span class="name">仮受付</span></li>'
          : '<li class="client-name"><span class="name">ご予約</span></li>';
        return `${checkbox}<div class="timetable-column line${line} active">
          <div class="reserve-content reserveFrame${t}_${line}">
            <ul class="info-list">${mark}</ul>
          </div></div>`;
      }).join('');
      return `<div id="id_${t}" class="timetable-line">${cells}</div>`;
    }).join('');

    return `<!doctype html><meta charset="utf-8"><title>受付管理</title>
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
      return send(`<!doctype html><meta charset="utf-8"><form method="post" action="/login">
        <input name="u" id="loginId"><input name="p" id="password" type="password">
        <button type="submit">ログイン</button></form>`);
    }
    if (url.pathname === '/login' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const form = new URLSearchParams(body);
        session = form.get('u') === user && form.get('p') === password;
        if (!session) return send('<!doctype html><meta charset="utf-8"><p class="error">ログインできません</p>');
        res.writeHead(302, { Location: `/schedule?date=${today}` });
        res.end();
      });
      return undefined;
    }

    if (!session) return send('<!doctype html><meta charset="utf-8"><p class="error">ログインしてください</p>');

    if (url.pathname === '/schedule') {
      return send(schedulePage(url.searchParams.get('date') || today));
    }

    if (url.pathname === '/apply') {
      const date = url.searchParams.get('date');
      const to = url.searchParams.get('to');
      for (const cell of (url.searchParams.get('cells') || '').split(',').filter(Boolean)) {
        const [time, line] = cell.split('_');
        if (to === 'tentative') filled.set(key(date, time, line), 'tentative');
        else filled.delete(key(date, time, line));
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
    setTentative: (date, time, line) => filled.set(key(date, time, line), 'tentative'),
    setBooked: (date, time, line) => filled.set(key(date, time, line), 'booked'),
    stop: () => new Promise((r) => server.close(r)),
    /** この作り物に合わせた画面設定。実物ではここだけが変わる */
    profile: {
      loginUrl: `${base}/login`,
      login: { user: '#loginId', password: '#password', submit: 'button[type="submit"]', ready: '#timetable' },
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
        checkbox: 'input[name="appoint"][value="{timeCompact}_{line}"]',
        closed: '.reserveFrame{timeCompact}_{line}',
        open: '.emptyFrame{timeCompact}_{line}',
        ours: '.reserveFrame{timeCompact}_{line} li.tentative-reservation',
      },
      close: [
        { click: '{checkbox}' },
        { click: '#multiple-select-panel .tentative-reservation a' },
        { waitFor: '#timetable' },
      ],
      open: [
        { click: '{checkbox}' },
        { click: '#multiple-select-panel .cancel a' },
        { waitFor: '#timetable' },
      ],
    },
  };
}
