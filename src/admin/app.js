// 予約管理画面。認証はブラウザの Basic 認証に任せる（同一オリジンの fetch に自動付与される）。
const API = '/api/admin';

function showMsg(text, ms = 2500) {
  const el = document.getElementById('msg');
  el.textContent = text;
  el.style.display = 'block';
  setTimeout(() => (el.style.display = 'none'), ms);
}

async function api(path, options = {}) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return body;
}

// JST の datetime-local 値を +09:00 付き ISO にして送る
function toJstIso(datetimeLocal) {
  return `${datetimeLocal}:00+09:00`;
}

const STATUS_LABELS = {
  requested: '承認待ち',
  confirmed: '確定',
  visited: '来店済',
  cancelled: 'キャンセル',
  no_show: '無断キャンセル',
};

function fmtJst(iso) {
  return new Date(iso).toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit',
  });
}

// ---- 予約一覧 ----
async function loadReservations() {
  const from = document.getElementById('list-from').value;
  const to = document.getElementById('list-to').value;
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);

  const { reservations } = await api(`/reservations?${params}`);
  const tbody = document.getElementById('reservations');
  tbody.innerHTML = '';
  for (const r of reservations) {
    const tr = document.createElement('tr');

    if (r.status === 'requested') tr.className = 'requested';

    // data-label は狭い画面のカード表示で見出しとして使う。
    // 日時と担当は折り返すと読みにくいので nowrap にする
    const cells = [
      { label: '日時', text: fmtJst(r.reserved_at), nowrap: true },
      { label: '顧客', text: r.customer_name },
      { label: 'メニュー', text: r.menu ?? '-' },
      { label: '担当', text: r.staff_name ?? '-', nowrap: true },
    ];
    for (const cell of cells) {
      const td = document.createElement('td');
      td.textContent = cell.text;
      td.dataset.label = cell.label;
      if (cell.nowrap) td.className = 'nowrap';
      tr.appendChild(td);
    }

    const statusTd = document.createElement('td');
    statusTd.dataset.label = '状態';
    statusTd.className = `status-${r.status}`;
    statusTd.textContent = STATUS_LABELS[r.status] ?? r.status;
    if (r.status === 'confirmed' && r.confirmed_by_customer) {
      const badge = document.createElement('span');
      badge.className = 'badge ok';
      badge.textContent = '本人確認済';
      statusTd.appendChild(badge);
    }
    tr.appendChild(statusTd);

    // 顧客がLIFFから書いたご要望
    const noteTd = document.createElement('td');
    noteTd.dataset.label = 'ご要望';
    noteTd.textContent = r.note ?? '';
    if (!r.note) noteTd.className = 'empty';
    tr.appendChild(noteTd);

    const actionTd = document.createElement('td');
    actionTd.dataset.label = '操作';
    actionTd.className = 'row-actions';

    const changeStatus = (status, confirmText) => async () => {
      if (!confirm(confirmText)) return;
      try {
        const { notifiedCustomer } = await api(`/reservations/${r.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ status }),
        });
        showMsg(notifiedCustomer ? '更新し、お客様へLINEで通知しました' : '更新しました');
        loadReservations();
      } catch (err) {
        showMsg(`エラー: ${err.message}`);
      }
    };

    // 承認待ちは「承認／見送り」、確定済みは日常操作（来店/取消/無断）
    if (r.status === 'requested') {
      const approve = document.createElement('button');
      approve.textContent = '承認';
      approve.onclick = changeStatus(
        'confirmed',
        `「${r.customer_name}」の予約を確定し、お客様へ確定通知を送りますか？`
      );
      actionTd.appendChild(approve);

      const decline = document.createElement('button');
      decline.textContent = '見送り';
      decline.className = 'sub';
      decline.onclick = changeStatus(
        'cancelled',
        `「${r.customer_name}」の予約リクエストを見送り、お客様へその旨を送りますか？`
      );
      actionTd.appendChild(decline);
    } else if (r.status === 'confirmed') {
      for (const [status, label, cls] of [
        ['visited', '来店', ''],
        ['cancelled', '取消', 'sub'],
        ['no_show', '無断', 'warn'],
      ]) {
        const btn = document.createElement('button');
        btn.textContent = label;
        if (cls) btn.className = cls;
        btn.onclick = changeStatus(
          status,
          `「${r.customer_name}」の予約を「${STATUS_LABELS[status]}」にしますか？`
        );
        actionTd.appendChild(btn);
      }
    }

    // 配信メッセージのテスト送信（宛先は常にテスト用アカウント）
    for (const [type, label] of [
      ['preReminder', '📩前々日'],
      ['afterVisit', '📩フォロー'],
    ]) {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.className = 'ghost';
      btn.title = 'テスト送信（テスト用アカウントに届きます）';
      btn.onclick = () => testSend({ type, reservationId: r.id });
      actionTd.appendChild(btn);
    }
    tr.appendChild(actionTd);
    tbody.appendChild(tr);
  }
}

document.getElementById('list-form').addEventListener('submit', (e) => {
  e.preventDefault();
  loadReservations().catch((err) => showMsg(`エラー: ${err.message}`));
});

// ---- テスト送信 ----
async function testSend(payload) {
  try {
    const { mode } = await api('/test-message', { method: 'POST', body: JSON.stringify(payload) });
    showMsg(
      mode === 'dry_run'
        ? 'dry_run のため送信せずログ出力しました（実際に受け取るには SEND_MODE=test にしてください）'
        : 'テスト用アカウントに送信しました'
    );
  } catch (err) {
    const messages = {
      live_mode: 'SEND_MODE=live ではテスト送信できません',
      reservation_not_found: '予約が見つかりません',
      customer_not_found: '顧客が見つかりません',
    };
    showMsg(messages[err.message] ?? `エラー: ${err.message}`);
  }
}

async function searchCustomersInto(query, selectId) {
  const { customers } = await api(`/customers?q=${encodeURIComponent(query)}`);
  const select = document.getElementById(selectId);
  select.innerHTML = '<option value="">顧客を選択</option>';
  for (const c of customers) {
    const opt = document.createElement('option');
    opt.value = c.id;
    const line = c.line_linked ? ' / LINE連携済' : '';
    opt.textContent = `${c.name}（${c.phone_norm ?? '電話なし'}${line}）`;
    select.appendChild(opt);
  }
  return customers.length;
}

document.getElementById('test-cust-search-btn').addEventListener('click', async () => {
  try {
    const count = await searchCustomersInto(
      document.getElementById('test-cust-search').value.trim(),
      'test-cust-select'
    );
    if (count === 0) showMsg('該当する顧客がいません');
  } catch (err) {
    showMsg(`エラー: ${err.message}`);
  }
});

for (const btn of document.querySelectorAll('#test-send [data-test-type]')) {
  btn.addEventListener('click', () => {
    const customerId = document.getElementById('test-cust-select').value;
    if (!customerId) return showMsg('顧客を選択してください');
    testSend({ type: btn.dataset.testType, customerId: Number(customerId) });
  });
}

// ---- 顧客検索（新規予約用） ----
document.getElementById('cust-search-btn').addEventListener('click', async () => {
  try {
    const count = await searchCustomersInto(
      document.getElementById('cust-search').value.trim(),
      'cust-select'
    );
    if (count === 0) showMsg('該当する顧客がいません');
  } catch (err) {
    showMsg(`エラー: ${err.message}`);
  }
});

// ---- 新規予約 ----
document.getElementById('new-reservation').addEventListener('submit', async (e) => {
  e.preventDefault();
  const customerId = document.getElementById('cust-select').value;
  const datetime = document.getElementById('res-datetime').value;
  if (!customerId) return showMsg('顧客を選択してください');
  if (!datetime) return showMsg('日時を入力してください');
  try {
    await api('/reservations', {
      method: 'POST',
      body: JSON.stringify({
        customerId: Number(customerId),
        reservedAt: toJstIso(datetime),
        menu: document.getElementById('res-menu').value || null,
        staffId: document.getElementById('res-staff').value || null,
      }),
    });
    showMsg('予約を登録しました');
    e.target.reset();
    loadReservations();
  } catch (err) {
    showMsg(`エラー: ${err.message}`);
  }
});

// ---- 顧客登録 ----
document.getElementById('new-customer').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/customers', {
      method: 'POST',
      body: JSON.stringify({
        name: document.getElementById('cust-name').value,
        phone: document.getElementById('cust-phone').value,
        birthday: document.getElementById('cust-birthday').value || null,
      }),
    });
    showMsg('顧客を登録しました');
    e.target.reset();
  } catch (err) {
    const messages = { phone_exists: 'この電話番号は登録済みです', invalid_phone: '電話番号の形式が不正です' };
    showMsg(messages[err.message] ?? `エラー: ${err.message}`);
  }
});

// ---- スタッフ ----
async function loadStaff() {
  const { staff } = await api('/staff');
  const select = document.getElementById('res-staff');
  select.innerHTML = '<option value="">担当（任意）</option>';
  for (const s of staff) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name;
    select.appendChild(opt);
  }
}

document.getElementById('new-staff').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/staff', {
      method: 'POST',
      body: JSON.stringify({ name: document.getElementById('staff-name').value }),
    });
    showMsg('スタッフを追加しました');
    e.target.reset();
    loadStaff();
  } catch (err) {
    showMsg(`エラー: ${err.message}`);
  }
});

// ---- メニュー管理 ----
async function loadMenus() {
  const { menus } = await api('/menus');
  const ul = document.getElementById('menus');
  ul.innerHTML = '';
  if (menus.length === 0) {
    const li = document.createElement('li');
    li.className = 'off';
    li.textContent = 'メニュー未登録（予約フォームに選択肢が出ません）';
    ul.appendChild(li);
    return;
  }
  for (const m of menus) {
    const li = document.createElement('li');
    if (!m.active) li.className = 'off';

    const label = document.createElement('span');
    label.textContent = m.duration_minutes ? `${m.name}（${m.duration_minutes}分）` : m.name;
    li.appendChild(label);

    const btn = document.createElement('button');
    btn.textContent = m.active ? '停止' : '再開';
    btn.className = m.active ? 'sub' : 'ghost';
    btn.onclick = async () => {
      try {
        await api(`/menus/${m.id}`, { method: 'PATCH', body: JSON.stringify({ active: !m.active }) });
        loadMenus();
      } catch (err) {
        showMsg(`エラー: ${err.message}`);
      }
    };
    li.appendChild(btn);
    ul.appendChild(li);
  }
}

document.getElementById('new-menu').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/menus', {
      method: 'POST',
      body: JSON.stringify({
        name: document.getElementById('menu-name').value,
        durationMinutes: document.getElementById('menu-duration').value || null,
      }),
    });
    showMsg('メニューを追加しました');
    e.target.reset();
    loadMenus();
  } catch (err) {
    showMsg(`エラー: ${err.message}`);
  }
});

// 初期表示
loadStaff().catch(() => showMsg('スタッフの取得に失敗しました'));
loadMenus().catch(() => showMsg('メニューの取得に失敗しました'));
loadReservations().catch((err) => showMsg(`エラー: ${err.message}`));

// ---- Instagram 投稿 ----
// 画像はブラウザ側で JPEG へ正規化する（サーバに画像処理ライブラリを足さないため）。
// Instagram が受け付ける縦横比（4:5 〜 1.91:1）から外れる写真は白地でパディングする。
const SNS_MAX_EDGE = 1440;
const snsPhotos = []; // { file: サーバ上のファイル名, url: プレビュー用 ObjectURL }

async function normalizeToJpeg(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  let cw = bmp.width;
  let ch = bmp.height;
  const ratio = bmp.width / bmp.height;
  if (ratio < 0.8) cw = Math.round(bmp.height * 0.8);       // 縦長すぎ → 横に余白
  else if (ratio > 1.91) ch = Math.round(bmp.width / 1.91); // 横長すぎ → 縦に余白
  const scale = Math.min(1, SNS_MAX_EDGE / Math.max(cw, ch));

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(cw * scale);
  canvas.height = Math.round(ch * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(
    bmp,
    Math.round((canvas.width - bmp.width * scale) / 2),
    Math.round((canvas.height - bmp.height * scale) / 2),
    Math.round(bmp.width * scale),
    Math.round(bmp.height * scale)
  );
  bmp.close();
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
}

function renderSnsGrid() {
  const grid = document.getElementById('sns-grid');
  grid.innerHTML = '';
  snsPhotos.forEach((p, i) => {
    const fig = document.createElement('figure');
    if (i >= 10) fig.className = 'second';
    const img = document.createElement('img');
    img.src = p.url;
    const no = document.createElement('span');
    no.className = 'no';
    no.textContent = i + 1;
    fig.append(img, no);
    grid.appendChild(fig);
  });
  const note = document.getElementById('sns-split-note');
  if (snsPhotos.length > 10) {
    note.textContent = `11枚以上のため自動で2つの投稿に分割されます（投稿1: 10枚 / 投稿2: ${snsPhotos.length - 10}枚）`;
    note.style.display = 'block';
  } else {
    note.style.display = 'none';
  }
}

document.getElementById('sns-files').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (snsPhotos.length + files.length > 20) {
    showMsg('写真は20枚まで（10枚×2投稿）です');
    return;
  }
  showMsg(`${files.length}枚を変換・アップロード中…`, 10000);
  try {
    for (const file of files) {
      const jpeg = await normalizeToJpeg(file);
      const res = await fetch(`${API}/sns/photos`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg' },
        body: jpeg,
      });
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`);
      snsPhotos.push({ file: body.file, url: URL.createObjectURL(jpeg) });
    }
    renderSnsGrid();
    showMsg(`アップロード完了（計${snsPhotos.length}枚）`);
  } catch (err) {
    showMsg(`アップロード失敗: ${err.message}`);
  }
});

async function submitSnsPost(scheduledAt) {
  if (snsPhotos.length === 0) return showMsg('先に写真を選んでください');
  const label = scheduledAt ? '予約' : '投稿';
  try {
    const body = await api('/sns/posts', {
      method: 'POST',
      body: JSON.stringify({
        caption: document.getElementById('sns-caption').value,
        files: snsPhotos.map((p) => p.file),
        scheduledAt,
      }),
    });
    const messages = {
      published: '投稿しました',
      dry_run: 'dry_run のため実投稿せず記録しました（実投稿には IG_POST_MODE=live が必要です）',
      scheduled: '予約しました。時刻になると自動で投稿されます',
    };
    showMsg(messages[body.status] || `${label}を受け付けました`, 4000);
    snsPhotos.length = 0;
    renderSnsGrid();
    document.getElementById('sns-caption').value = '';
    loadSnsPosts();
  } catch (err) {
    showMsg(`${label}に失敗しました: ${err.message}`, 5000);
    loadSnsPosts();
  }
}

document.getElementById('sns-post-now').addEventListener('click', () => {
  if (!confirm(`${snsPhotos.length}枚を今すぐ投稿しますか？`)) return;
  submitSnsPost(null);
});
document.getElementById('sns-post-schedule').addEventListener('click', () => {
  const at = document.getElementById('sns-schedule-at').value;
  if (!at) return showMsg('予約日時を指定してください');
  submitSnsPost(toJstIso(at));
});

const SNS_STATUS_LABELS = {
  scheduled: '予約中',
  publishing: '投稿処理中',
  published: '投稿済み',
  dry_run: 'dry_run',
  failed: '失敗',
};

async function loadSnsPosts() {
  const { posts } = await api('/sns/posts');
  const tbody = document.getElementById('sns-posts');
  tbody.innerHTML = '';
  for (const p of posts) {
    const tr = document.createElement('tr');
    const thumb = p.thumb ? `<img class="sns-thumb" src="/sns-media/${p.thumb}" alt="">` : '';
    const when = p.published_at ?? p.scheduled_at;
    tr.innerHTML =
      `<td>${thumb}</td>` +
      `<td class="nowrap">${fmtJst(when)}</td>` +
      `<td>${p.photo_count}</td>` +
      `<td class="sns-status-${p.status}">${SNS_STATUS_LABELS[p.status] ?? p.status}` +
      (p.error ? `<div class="note" style="margin:4px 0 0">${p.error}</div>` : '') +
      `</td>` +
      `<td>${(p.caption || '').slice(0, 40)}</td>`;
    const td = document.createElement('td');
    if (p.status === 'scheduled' || p.status === 'failed') {
      const btn = document.createElement('button');
      btn.className = 'sub';
      btn.textContent = '取消';
      btn.onclick = async () => {
        if (!confirm('この投稿を取り消しますか？（写真も削除されます）')) return;
        try {
          await api(`/sns/posts/${p.id}/cancel`, { method: 'POST' });
          showMsg('取り消しました');
          loadSnsPosts();
        } catch (err) {
          showMsg(`エラー: ${err.message}`);
        }
      };
      td.appendChild(btn);
    }
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

loadSnsPosts().catch(() => {});
