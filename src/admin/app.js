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

    const cells = [
      fmtJst(r.reserved_at),
      r.customer_name,
      r.menu ?? '-',
      r.staff_name ?? '-',
    ];
    for (const text of cells) {
      const td = document.createElement('td');
      td.textContent = text;
      tr.appendChild(td);
    }

    const statusTd = document.createElement('td');
    statusTd.className = `status-${r.status}`;
    statusTd.textContent = STATUS_LABELS[r.status] ?? r.status;
    if (r.status === 'confirmed' && r.confirmed_by_customer) {
      const badge = document.createElement('span');
      badge.className = 'badge ok';
      badge.textContent = '本人確認済';
      statusTd.appendChild(badge);
    }
    tr.appendChild(statusTd);

    const actionTd = document.createElement('td');
    actionTd.className = 'row-actions';
    if (r.status === 'confirmed') {
      for (const [status, label, cls] of [
        ['visited', '来店', ''],
        ['cancelled', '取消', 'sub'],
        ['no_show', '無断', 'warn'],
      ]) {
        const btn = document.createElement('button');
        btn.textContent = label;
        if (cls) btn.className = cls;
        btn.onclick = async () => {
          if (!confirm(`「${r.customer_name}」の予約を「${STATUS_LABELS[status]}」にしますか？`)) return;
          try {
            await api(`/reservations/${r.id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
            showMsg('更新しました');
            loadReservations();
          } catch (err) {
            showMsg(`エラー: ${err.message}`);
          }
        };
        actionTd.appendChild(btn);
      }
    }
    tr.appendChild(actionTd);
    tbody.appendChild(tr);
  }
}

document.getElementById('list-form').addEventListener('submit', (e) => {
  e.preventDefault();
  loadReservations().catch((err) => showMsg(`エラー: ${err.message}`));
});

// ---- 顧客検索（新規予約用） ----
document.getElementById('cust-search-btn').addEventListener('click', async () => {
  const q = document.getElementById('cust-search').value.trim();
  try {
    const { customers } = await api(`/customers?q=${encodeURIComponent(q)}`);
    const select = document.getElementById('cust-select');
    select.innerHTML = '<option value="">顧客を選択</option>';
    for (const c of customers) {
      const opt = document.createElement('option');
      opt.value = c.id;
      const line = c.line_linked ? ' / LINE連携済' : '';
      opt.textContent = `${c.name}（${c.phone_norm ?? '電話なし'}${line}）`;
      select.appendChild(opt);
    }
    if (customers.length === 0) showMsg('該当する顧客がいません');
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

// 初期表示
loadStaff().catch(() => showMsg('スタッフの取得に失敗しました'));
loadReservations().catch((err) => showMsg(`エラー: ${err.message}`));
