// スタッフ登録（LIFF）。グループに置いたボタンから開く。
//
// userId はクライアントから送らず、ID トークンをサーバーで検証させる（予約フォームと同じ方針）。
// 誰が開いたかはサーバー側で確定し、さらに「スタッフ用グループにいるか」も
// サーバー側で確かめる。この画面の URL が漏れても、グループ外の人は登録できない。

let idToken = null;
let staffId = null;

function show(id) { document.getElementById(id).classList.remove('hidden'); }
function hide(id) { document.getElementById(id).classList.add('hidden'); }
function showStatus(message, kind) {
  const el = document.getElementById('status');
  el.textContent = message;
  el.className = kind || '';
}

const DENIED_MESSAGES = {
  not_in_group: 'スタッフ用のLINEグループに参加している方のみ登録できます。\n'
    + 'グループに参加したうえで、もう一度お試しください。',
  group_not_configured: 'スタッフ用のLINEグループがまだ設定されていません。\n'
    + 'Bot をスタッフ用のグループに招待してから、もう一度お試しください。',
  membership_unknown: '参加状況を確認できませんでした。\n'
    + 'お手数ですが、少し時間をおいてからもう一度お試しください。',
  invalid_token: '認証に失敗しました。LINEアプリから開き直してください。',
  liff_not_configured: 'この画面はまだ使えません。店長にお問い合わせください。',
  shift_disabled: 'この画面はまだ使えません。店長にお問い合わせください。',
};

const LINK_ERRORS = {
  already_linked_to_other: 'このLINEアカウントは、すでに別のスタッフとして登録されています。\n'
    + '店長にご相談ください。',
  not_found: 'その名前が見つかりませんでした。画面を開き直してお試しください。',
  invalid_staff: 'お名前をもう一度お選びください。',
};

function deny(error) {
  hide('loading');
  document.getElementById('denied-note').textContent =
    DENIED_MESSAGES[error] || '登録できませんでした。店長にお問い合わせください。';
  show('denied');
}

function renderList(staff, linkedStaffId) {
  const list = document.getElementById('list');
  list.innerHTML = '';
  for (const s of staff) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pick';
    btn.textContent = s.name;
    // 既に誰かのLINEと結びついている名前は、選ぶ前に分かるようにしておく
    if (s.linked) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = s.id === linkedStaffId ? '登録済み（あなた）' : '登録済み';
      btn.appendChild(tag);
    }
    btn.addEventListener('click', () => {
      staffId = s.id;
      list.querySelectorAll('.pick').forEach((b) => b.classList.remove('on'));
      btn.classList.add('on');
      document.getElementById('submit').disabled = false;
      showStatus('');
    });
    li.appendChild(btn);
    list.appendChild(li);
  }
}

async function submit() {
  const button = document.getElementById('submit');
  const chosen = document.querySelector('.pick.on');
  // 既に別のLINEと結びついている名前を選んだときは、取り違えを防ぐため一度確認する
  if (chosen && chosen.querySelector('.tag') && !chosen.querySelector('.tag').textContent.includes('あなた')) {
    if (!confirm('この名前はすでに別のLINEアカウントで登録されています。\nこのアカウントに切り替えますか？')) return;
  }

  button.disabled = true;
  showStatus('登録しています…');
  try {
    const res = await fetch('./staff/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken, staffId }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) {
      showStatus(LINK_ERRORS[body.error] || '登録できませんでした。もう一度お試しください。', 'error');
      button.disabled = false;
      return;
    }
    hide('pick');
    document.getElementById('done-name').textContent = `${body.staff.name}さんとして登録しました`;
    show('done');
  } catch {
    showStatus('通信に失敗しました。電波の良いところでお試しください。', 'error');
    button.disabled = false;
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

  const optionsRes = await fetch('./staff/options', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken }),
  });
  const options = await optionsRes.json().catch(() => ({}));
  if (!optionsRes.ok || !options.eligible) {
    deny(options.error);
    return;
  }

  hide('loading');
  renderList(options.staff, options.linkedStaffId);
  show('pick');
  document.getElementById('submit').addEventListener('click', submit);
  document.getElementById('close').addEventListener('click', () => liff.closeWindow());
}

main().catch((err) => {
  document.getElementById('loading').textContent = `読み込みに失敗しました: ${err.message}`;
});
