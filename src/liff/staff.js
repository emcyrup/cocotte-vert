// スタッフ登録（LIFF）。スタッフ用グループに置いたボタンから開く。
//
// userId はクライアントから送らず、ID トークンをサーバーで検証させる（予約フォームと同じ方針）。
// 誰が開いたかはサーバー側で確定し、さらに「スタッフ用グループにいるか」も
// サーバー側で確かめる。この画面の URL が漏れても、グループ外の人は登録できない。
//
// 名前は本人に入力してもらう。名簿に無ければ新しいスタッフとして登録される。
// 同姓が複数いるときだけ、どちらかを選んでもらう（こちらでは決めようがないため）。

let idToken = null;
// このLINEが今どのスタッフとして登録されているか。候補の中から自分を見分けるのに使う
let myStaff = null;

function show(id) { document.getElementById(id).classList.remove('hidden'); }
function hide(id) { document.getElementById(id).classList.add('hidden'); }
function showStatus(message, kind, id = 'status') {
  const el = document.getElementById(id);
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
  invalid_name: 'お名前を入力してください（30文字まで）。',
  // 同じ名前で上書きすると、先に登録した人の連携が消える。区別の付く名前を入れてもらう
  name_taken: null,   // 名前が入るので submit 側で組み立てる
  staff_taken: 'その方はすでに別のLINEアカウントで登録されています。\n'
    + '同じお名前の別の方は、区別の付くお名前を入力してください。',
  already_linked_to_other: 'このLINEアカウントは、すでに別のスタッフとして登録されています。\n'
    + '店長にご相談ください。',
  not_found: 'その方が見つかりませんでした。画面を開き直してお試しください。',
  invalid_staff: 'お名前をもう一度お選びください。',
};

function deny(error) {
  hide('loading');
  document.getElementById('denied-note').textContent =
    DENIED_MESSAGES[error] || '登録できませんでした。店長にお問い合わせください。';
  show('denied');
}

function done(staff, created) {
  hide('pick');
  hide('choose');
  document.getElementById('done-name').textContent =
    `${staff.name}さんとして${created ? '新しく' : ''}登録しました`;
  show('done');
}

/** 同姓が複数いたときに、どちらかを選んでもらう */
function renderCandidates(candidates) {
  const list = document.getElementById('list');
  list.innerHTML = '';
  for (const c of candidates) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pick';
    // 同姓が並ぶので、自分のぶんが分かるようにしておく
    const mine = myStaff && String(myStaff.id) === String(c.id);
    btn.textContent = mine ? `${c.name}（あなた）` : (c.linked ? `${c.name}（登録済み）` : c.name);
    btn.addEventListener('click', () => submit({ staffId: c.id }, 'status2'));
    li.appendChild(btn);
    list.appendChild(li);
  }
  hide('pick');
  show('choose');
}

async function submit(payload, statusId = 'status') {
  const button = document.getElementById('submit');
  button.disabled = true;
  showStatus('登録しています…', '', statusId);
  try {
    const res = await fetch('./staff/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken, ...payload }),
    });
    const body = await res.json().catch(() => ({}));

    if (body.error === 'ambiguous' && body.candidates?.length) {
      showStatus('', '', statusId);
      renderCandidates(body.candidates);
      button.disabled = false;
      return;
    }

    if (!res.ok || !body.ok) {
      const message = body.error === 'name_taken'
        ? `「${body.staff?.name ?? payload.name}」さんはすでに登録されています。\n`
          + '同じお名前の別の方は、区別の付くお名前を入力してください（例：高橋 花子）。\n'
          + 'ご本人が登録し直す場合は、店長にご相談ください。'
        : LINK_ERRORS[body.error];
      showStatus(message || '登録できませんでした。もう一度お試しください。', 'error', statusId);
      button.disabled = false;
      // 入れ直してもらうので、入力欄へ戻す
      if (body.error === 'name_taken') document.getElementById('name').focus();
      return;
    }
    done(body.staff, body.created);
  } catch {
    showStatus('通信に失敗しました。電波の良いところでお試しください。', 'error', statusId);
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
  const nameInput = document.getElementById('name');
  myStaff = options.linkedStaff ?? null;
  if (options.linkedStaff) {
    // 登録済みでも開けるようにしておく（改名・入れ直しのため）。今の名前を入れておく
    nameInput.value = options.linkedStaff.name;
    document.getElementById('already').textContent =
      `このLINEアカウントは、すでに「${options.linkedStaff.name}」さんとして登録されています。`;
  }
  show('pick');

  document.getElementById('submit').addEventListener('click', () => submit({ name: nameInput.value }));
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit({ name: nameInput.value }); });
  document.getElementById('close').addEventListener('click', () => liff.closeWindow());
}

main().catch((err) => {
  document.getElementById('loading').textContent = `読み込みに失敗しました: ${err.message}`;
});
