// スタッフ用の予約登録フォーム（LIFF）。グループ／1:1 で「予約登録」と送ると出るボタンから開く。
//
// 文章での予約登録はお名前の読み取りが当たらないことがある。この画面では探して選んでもらい、
// お客様を確定させてから登録する。userId はクライアントから送らず、ID トークンを
// サーバーで検証させる（他のスタッフ画面と同じ方針）。

let idToken = null;
// 選んだお客様。null なら「新規のお客様」か、まだ決まっていない
let picked = null;

const $ = (id) => document.getElementById(id);
const show = (id) => $(id).classList.remove('hidden');
const hide = (id) => $(id).classList.add('hidden');

function showStatus(id, message, kind) {
  const el = $(id);
  el.textContent = message;
  el.className = kind || '';
}

const DENIED_MESSAGES = {
  not_in_group: 'スタッフ用のLINEグループに参加している方のみ使えます。',
  group_not_configured: 'スタッフ用のLINEグループがまだ設定されていません。\n'
    + 'Bot をスタッフ用のグループに招待してから、もう一度お試しください。',
  membership_unknown: '参加状況を確認できませんでした。\n'
    + 'お手数ですが、少し時間をおいてからもう一度お試しください。',
  invalid_token: '認証に失敗しました。LINEアプリから開き直してください。',
  liff_not_configured: 'この画面はまだ使えません。店長にお問い合わせください。',
};

const CREATE_ERRORS = {
  invalid_customer: 'お客様が決まっていません。探して選ぶか、新規のお名前を入れてください。',
  invalid_reserved_at: '日時をご確認ください。',
  invalid_checkout: '退室予定日は、お預かりの日より後の日付にしてください。',
  invalid_staff: '担当をもう一度お選びください。',
  invalid_duration: '所要時間は1〜1440分の範囲で入れてください。',
  customer_not_found: 'そのお客様が見つかりませんでした。選び直してください。',
};

function deny(error) {
  hide('loading');
  $('denied-note').textContent =
    DENIED_MESSAGES[error] || '使えませんでした。店長にお問い合わせください。';
  show('denied');
}

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken, ...body }),
  });
  return { ok: res.ok, body: await res.json().catch(() => ({})) };
}

// ---- お客様を決める ----

/** 候補の見分けが付くよう、わんちゃんの名前とお電話番号の下4桁を添える */
function subLabel(c) {
  const parts = [];
  if (c.pets?.length) parts.push(`わんちゃん: ${c.pets.join('・')}`);
  parts.push(c.phoneLast4 ? `電話 下4桁 ${c.phoneLast4}` : '電話未登録');
  return parts.join('／');
}

function choose(customer) {
  picked = customer;
  $('chosen').innerHTML = '';
  const name = document.createElement('b');
  name.textContent = `${customer.name}様`;
  const sub = document.createElement('span');
  sub.className = 'sub';
  sub.textContent = subLabel(customer);
  $('chosen').append(name, sub);

  hide('search-box');
  hide('new-box');
  show('chosen');
  show('rechoose');
}

function renderResults(customers) {
  const list = $('results');
  list.innerHTML = '';
  for (const c of customers) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pick';
    const name = document.createElement('b');
    name.textContent = `${c.name}様`;
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = subLabel(c);
    btn.append(name, sub);
    btn.addEventListener('click', () => choose(c));
    li.appendChild(btn);
    list.appendChild(li);
  }
}

async function search() {
  const q = $('q').value.trim();
  if (!q) {
    showStatus('search-status', '探す言葉を入れてください。', 'error');
    return;
  }
  showStatus('search-status', '探しています…', '');
  $('results').innerHTML = '';
  try {
    const { ok, body } = await post('./staff-reserve/customers', { q });
    if (!ok) {
      showStatus('search-status', DENIED_MESSAGES[body.error] || '探せませんでした。', 'error');
      return;
    }
    if (!body.customers.length) {
      showStatus(
        'search-status',
        '見つかりませんでした。お名前の一部だけでも探せます。\n'
          + 'はじめてのお客様なら「新規で登録する」からお進みください。',
        ''
      );
      return;
    }
    showStatus('search-status', '', '');
    renderResults(body.customers);
  } catch {
    showStatus('search-status', '通信に失敗しました。電波の良いところでお試しください。', 'error');
  }
}

function backToSearch() {
  picked = null;
  hide('chosen');
  hide('rechoose');
  hide('new-box');
  show('search-box');
}

function asNew() {
  picked = null;
  hide('search-box');
  hide('chosen');
  hide('rechoose');
  show('new-box');
  $('new-name').focus();
}

// ---- 登録 ----

// datetime-local は端末のローカル時刻で入る。JST 前提のサービスなので +09:00 を明示して送り、
// サーバー側の解釈を端末設定に依存させない
const toJstIso = (value) => `${value}:00+09:00`;

function jstNow() {
  return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 16);
}

// HH:MM を30分の区切りまで繰り上げる。日欄は30分刻みなので、半端な値を初期値に
// 入れると開いた瞬間から「不正な値」になってしまう
function toHalfHour(time) {
  const [h, m] = String(time).split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return '10:00';
  const at = Math.min(Math.ceil((h * 60 + m) / 30) * 30, 23 * 60 + 30);
  return `${String(Math.floor(at / 60)).padStart(2, '0')}:${String(at % 60).padStart(2, '0')}`;
}

async function submit() {
  const button = $('submit');
  const datetime = $('datetime').value;
  if (!datetime) {
    showStatus('status', '日時を入れてください。', 'error');
    return;
  }

  const newName = $('new-name').value.trim();
  if (!picked && !newName) {
    showStatus('status', 'お客様を探して選ぶか、新規のお名前を入れてください。', 'error');
    return;
  }

  const stay = $('stay').checked;
  if (stay && !$('checkout').value) {
    showStatus('status', '退室予定日を入れてください。', 'error');
    return;
  }

  const menuSelect = $('menu');
  button.disabled = true;
  showStatus('status', '登録しています…', '');
  try {
    const { ok, body } = await post('./staff-reserve/create', {
      customerId: picked ? picked.id : null,
      newCustomerName: picked ? null : newName,
      newCustomerPhone: picked ? null : $('new-phone').value || null,
      reservedAt: toJstIso(datetime),
      // 予約にはコース名をそのまま持たせる（あとでコース名を変えても過去の予約は変わらない）
      menu: menuSelect.value || null,
      staffId: $('staff').value || null,
      durationMinutes: $('duration').value || null,
      checkoutDate: stay ? $('checkout').value : null,
      note: $('note').value || null,
    });

    if (!ok || !body.ok) {
      showStatus(
        'status',
        CREATE_ERRORS[body.error] || DENIED_MESSAGES[body.error]
          || '登録できませんでした。もう一度お試しください。',
        'error'
      );
      button.disabled = false;
      return;
    }

    const lines = [
      `${picked ? picked.name : newName}様`,
      datetime.replace('T', ' '),
      menuSelect.options[menuSelect.selectedIndex]?.text || 'コース未定',
    ];
    if (body.stay) lines.push(`お泊まり ${body.stay}`);
    if (body.createdCustomer) {
      lines.push('新しいお客様として登録しました。お電話番号などは店舗管理画面から追加してください。');
    }
    $('done-detail').textContent = lines.join('\n');
    hide('form');
    show('done');
  } catch {
    showStatus('status', '通信に失敗しました。電波の良いところでお試しください。', 'error');
    button.disabled = false;
  }
}

/**
 * 続けて登録するとき。お客様と内容だけ空にし、読み込み直さない。
 * 日時と担当は前のまま残す（同じ日の予約を続けて入れることが多い）。
 * コースは残さない。別のお客様に前のコースがそのまま付くと気付きにくいため
 */
function reset() {
  backToSearch();
  for (const id of ['q', 'new-name', 'new-phone', 'duration', 'note', 'checkout']) $(id).value = '';
  $('menu').value = '';
  $('results').innerHTML = '';
  $('stay').checked = false;
  hide('stay-box');
  showStatus('status', '', '');
  showStatus('search-status', '', '');
  $('submit').disabled = false;
  hide('done');
  show('form');
}

// ---- 起動 ----

function fillSelect(select, items, blankLabel) {
  select.innerHTML = '';
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = blankLabel;
  select.appendChild(blank);
  for (const item of items) {
    const opt = document.createElement('option');
    // コースは名前をそのまま予約に持たせるので value も名前にする
    opt.value = item.value;
    opt.textContent = item.label;
    select.appendChild(opt);
  }
}

async function main() {
  const res = await fetch('./config');
  if (!res.ok) throw new Error('設定の取得に失敗しました');
  const { liffId } = await res.json();

  await liff.init({ liffId });
  if (!liff.isLoggedIn()) {
    liff.login();
    return;
  }
  idToken = liff.getIDToken();

  const { ok, body: options } = await post('./staff-reserve/options', {});
  if (!ok || !options.eligible) {
    deny(options.error);
    return;
  }

  fillSelect(
    $('menu'),
    options.menus.map((m) => ({
      value: m.name,
      label: m.duration_minutes ? `${m.name}（約${m.duration_minutes}分）` : m.name,
    })),
    'コース未定'
  );
  fillSelect(
    $('staff'),
    options.staff.map((s) => ({ value: String(s.id), label: s.name })),
    '担当未定'
  );
  // 開いた本人が担当になることが多いので、連携済みならそこを初期値にする
  if (options.me) $('staff').value = String(options.me.id);

  // お電話で受けたその場で入れる使い方が多い。今日の開店時刻を初期値にしておく。
  // 欄は30分刻みなので、開店時刻が半端でも区切りまで繰り上げて入れる（開店前を出さない）
  $('datetime').value = `${jstNow().slice(0, 10)}T${toHalfHour(options.openTime || '10:00')}`;

  hide('loading');
  show('form');

  $('search').addEventListener('click', search);
  $('q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); search(); }
  });
  $('as-new').addEventListener('click', asNew);
  $('as-search').addEventListener('click', backToSearch);
  $('rechoose').addEventListener('click', backToSearch);
  $('stay').addEventListener('change', (e) => {
    if (e.target.checked) {
      // 退室日は入室の翌日を初期値にする（1泊が一番多い）
      const next = new Date(`${$('datetime').value.slice(0, 10)}T12:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      $('checkout').value = next.toISOString().slice(0, 10);
      show('stay-box');
    } else {
      hide('stay-box');
    }
  });
  $('submit').addEventListener('click', submit);
  $('again').addEventListener('click', reset);
  $('close').addEventListener('click', () => liff.closeWindow());
}

main().catch((err) => {
  $('loading').textContent = `読み込みに失敗しました: ${err.message}`;
});
