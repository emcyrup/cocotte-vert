// EPARK 管理画面の「ごく単純な作り物」。
//
// 実物の画面を見られないため、駆動部の**仕組み**（ログイン → 日付の画面 → 枠を押す →
// 読み直して確かめる）だけをここで通す。実物に合わせるのはセレクタの設定であって
// コードではないので、ここが通れば残りは設定の差し替えで済む、という位置づけ。
//
// わざと次の性質を持たせている（実物でも起きること）:
//   - ログインしていないと日付の画面は開けない
//   - 「閉じる」は確認ボタンを押すまで確定しない（複数手順）
//   - 保存すると画面が作り替わる

import http from 'node:http';

const TIMES = ['10:00', '11:00', '12:00', '13:00', '14:00'];

const page = (body) =>
  `<!doctype html><meta charset="utf-8"><title>fake epark</title>` +
  `<style>.slot{padding:4px}.is-closed{background:#ccc}</style>${body}`;

export async function startFakeEpark({ user = 'shop', password = 'pw' } = {}) {
  // 閉じている枠: "YYYY-MM-DD HH:MM" の集合
  const closed = new Set();
  // 押された枠（確認ボタン待ち）
  let pending = null;
  let session = false;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (html) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page(html));
    };

    if (url.pathname === '/login' && req.method === 'GET') {
      return send(
        `<form method="post" action="/login">
           <input name="u" id="loginId"><input name="p" id="password" type="password">
           <button type="submit">ログイン</button>
         </form>`
      );
    }
    if (url.pathname === '/login' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const form = new URLSearchParams(body);
        session = form.get('u') === user && form.get('p') === password;
        if (!session) return send('<p class="error">ログインできません</p>');
        res.writeHead(302, { Location: '/schedule?date=2026-09-01' });
        res.end();
      });
      return undefined;
    }

    if (url.pathname === '/schedule') {
      if (!session) return send('<p class="error">ログインしてください</p>');
      const date = url.searchParams.get('date');
      const rows = TIMES.map((t) => {
        const isClosed = closed.has(`${date} ${t}`);
        const label = isClosed ? '休止中' : '受付中';
        return `<div class="slot${isClosed ? ' is-closed' : ''}" data-time="${t}">
                  <span class="state">${label}</span>
                  <a href="/pick?date=${date}&time=${t}">この枠を編集</a>
                </div>`;
      }).join('');
      return send(`<h1 id="dash">${date}</h1>${rows}`);
    }

    if (url.pathname === '/pick') {
      if (!session) return send('<p class="error">ログインしてください</p>');
      pending = { date: url.searchParams.get('date'), time: url.searchParams.get('time') };
      const key = `${pending.date} ${pending.time}`;
      return send(
        `<p>${key}</p>
         <a href="/apply?to=closed">枠を閉じる</a>
         <a href="/apply?to=open">枠を開ける</a>
         <p>${closed.has(key) ? '現在: 休止中' : '現在: 受付中'}</p>`
      );
    }

    if (url.pathname === '/apply') {
      if (!session || !pending) return send('<p class="error">操作できません</p>');
      const key = `${pending.date} ${pending.time}`;
      if (url.searchParams.get('to') === 'closed') closed.add(key);
      else closed.delete(key);
      const date = pending.date;
      pending = null;
      res.writeHead(302, { Location: `/schedule?date=${date}&saved=1` });
      return res.end();
    }

    res.writeHead(404).end('not found');
    return undefined;
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    base,
    closed,
    isClosed: (date, time) => closed.has(`${date} ${time}`),
    setClosed: (date, time) => closed.add(`${date} ${time}`),
    stop: () => new Promise((r) => server.close(r)),
    /** この作り物に合わせた画面設定。実物ではここだけが変わる */
    profile: {
      loginUrl: `${base}/login`,
      login: { user: '#loginId', password: '#password', submit: 'button[type="submit"]', ready: '#dash' },
      dayUrl: `${base}/schedule?date={date}`,
      slot: '.slot[data-time="{time}"]',
      closedWhen: '.is-closed',
      close: [
        { click: '{slot} a' },
        { click: 'a:has-text("枠を閉じる")' },
        { waitFor: '#dash' },
      ],
      open: [
        { click: '{slot} a' },
        { click: 'a:has-text("枠を開ける")' },
        { waitFor: '#dash' },
      ],
    },
  };
}
