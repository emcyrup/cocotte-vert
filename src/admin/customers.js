// 顧客管理ページ（お客様＋ペットの参照・編集）。認証はブラウザの Basic 認証に任せる。
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
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

const CUSTOMER_ERRORS = {
  phone_exists: 'この電話番号は別のお客様に登録済みです',
  invalid_phone: '電話番号の形式が不正です',
  invalid_name: 'お名前を入力してください',
  invalid_birthday: '誕生日の形式が不正です',
};

const fmtDate = (iso) =>
  iso
    ? new Date(iso).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric' })
    : '-';

// input[type=date] に入れる用（YYYY-MM-DD のまま切り出す）
const dateValue = (iso) => (iso ? String(iso).slice(0, 10) : '');

const el = (tag, props = {}, children = []) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children) node.append(child);
  return node;
};

// ---- 顧客一覧 ----

async function loadCustomers() {
  const q = document.getElementById('search-q').value.trim();
  const { customers } = await api(`/customers?q=${encodeURIComponent(q)}`);
  const wrap = document.getElementById('customers');
  wrap.innerHTML = '';
  if (customers.length === 0) {
    wrap.appendChild(el('p', { className: 'empty', textContent: '該当するお客様がいません' }));
    return;
  }
  for (const c of customers) wrap.appendChild(customerCard(c));
}

function customerCard(c) {
  const details = el('details', { className: 'cust' });

  const summary = el('summary', {}, [
    el('span', { className: 'cust-name', textContent: c.name }),
    el('span', { className: 'cust-sub', textContent: c.phone_norm ?? '電話未登録' }),
    el('span', { className: 'cust-sub', textContent: c.pet_names ? `🐾 ${c.pet_names}` : '' }),
    el('span', { className: `badge${c.line_linked ? ' ok' : ''}`, textContent: c.line_linked ? 'LINE連携済' : 'LINE未連携' }),
  ]);
  if (c.opt_out) summary.appendChild(el('span', { className: 'badge warn', textContent: '配信停止' }));
  if (c.is_blocked) summary.appendChild(el('span', { className: 'badge warn', textContent: 'ブロック' }));
  details.appendChild(summary);

  const body = el('div', { className: 'cust-body' });
  details.appendChild(body);

  // 開いたときにペットを読み込む（一覧表示を軽く保つため）
  let loaded = false;
  details.addEventListener('toggle', async () => {
    if (!details.open || loaded) return;
    loaded = true;
    try {
      const { pets } = await api(`/customers/${c.id}/pets`);
      renderBody(body, c, pets);
    } catch (err) {
      showMsg(`ペット情報の取得に失敗: ${err.message}`);
    }
  });

  return details;
}

// ---- 顧客本体の表示・編集 ----

function renderBody(body, c, pets) {
  body.innerHTML = '';

  const fields = el('dl', { className: 'fields' });
  const addField = (label, value) => {
    fields.append(el('dt', { textContent: label }), el('dd', { textContent: value }));
  };
  addField('お名前', c.name);
  addField('電話番号', c.phone_norm ?? '-');
  addField('誕生日', fmtDate(c.birthday));
  addField('最終来店', fmtDate(c.last_visit_at));
  addField('配信', c.opt_out ? '停止中' : c.is_blocked ? 'ブロック中' : '○');
  body.appendChild(fields);

  const editBtn = el('button', { type: 'button', className: 'ghost', textContent: 'お客様情報を編集' });
  editBtn.addEventListener('click', () => renderCustomerEdit(body, c, pets));
  body.appendChild(el('div', { className: 'actions' }, [editBtn]));

  renderPets(body, c, pets);
}

function renderCustomerEdit(body, c, pets) {
  body.innerHTML = '';
  const nameIn = el('input', { value: c.name, placeholder: 'お名前' });
  const phoneIn = el('input', { type: 'tel', value: c.phone_norm ?? '', placeholder: '電話番号' });
  const bdayIn = el('input', { type: 'date', value: dateValue(c.birthday) });
  const optIn = el('input', { type: 'checkbox', checked: c.opt_out });

  body.appendChild(
    el('div', { className: 'cust-edit' }, [
      nameIn,
      phoneIn,
      bdayIn,
      el('label', {}, [optIn, ' 配信を停止する']),
    ])
  );

  const saveBtn = el('button', { type: 'button', textContent: '保存' });
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      await api(`/customers/${c.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: nameIn.value,
          phone: phoneIn.value,
          birthday: bdayIn.value || null,
          optOut: optIn.checked,
        }),
      });
      Object.assign(c, {
        name: nameIn.value.trim(),
        phone_norm: phoneIn.value.trim() || null,
        birthday: bdayIn.value || null,
        opt_out: optIn.checked,
      });
      showMsg('お客様情報を更新しました');
      renderBody(body, c, pets);
    } catch (err) {
      showMsg(CUSTOMER_ERRORS[err.message] ?? `エラー: ${err.message}`);
      saveBtn.disabled = false;
    }
  });
  const cancelBtn = el('button', { type: 'button', className: 'ghost', textContent: '取消' });
  cancelBtn.addEventListener('click', () => renderBody(body, c, pets));
  body.appendChild(el('div', { className: 'actions' }, [saveBtn, cancelBtn]));

  renderPets(body, c, pets);
}

// ---- ペットの表示・編集 ----

function renderPets(body, c, pets) {
  body.appendChild(el('h3', { textContent: `ペット（${pets.length}頭）` }));

  const list = el('div');
  body.appendChild(list);
  for (const p of pets) list.appendChild(petCard(list, c, pets, p));
  if (pets.length === 0) {
    list.appendChild(el('p', { className: 'empty', textContent: 'ペットが未登録です' }));
  }

  const addBtn = el('button', { type: 'button', textContent: '＋ ペットを追加' });
  addBtn.addEventListener('click', () => {
    addBtn.disabled = true;
    const card = el('div', { className: 'pet' });
    petForm(card, c, pets, null, () => {
      addBtn.disabled = false;
      refreshPets(body, c);
    }, () => {
      card.remove();
      addBtn.disabled = false;
    });
    list.appendChild(card);
  });
  body.appendChild(el('div', { className: 'actions' }, [addBtn]));
}

function petCard(list, c, pets, p) {
  const card = el('div', { className: 'pet' });
  const view = () => {
    card.innerHTML = '';
    const head = el('div', { className: 'pet-head' }, [
      el('span', { className: 'pet-name', textContent: p.name }),
      el('span', { className: 'pet-sub', textContent: [p.breed, p.birthday ? `誕生日 ${fmtDate(p.birthday)}` : null].filter(Boolean).join('・') }),
    ]);
    card.appendChild(head);
    if (p.notes) card.appendChild(el('div', { className: 'pet-notes', textContent: p.notes }));

    const editBtn = el('button', { type: 'button', className: 'ghost', textContent: '編集' });
    editBtn.addEventListener('click', () => {
      petForm(card, c, pets, p, view, view);
    });
    const delBtn = el('button', { type: 'button', className: 'warn', textContent: '削除' });
    delBtn.addEventListener('click', async () => {
      if (!confirm(`${p.name} の情報を削除しますか？`)) return;
      try {
        await api(`/pets/${p.id}`, { method: 'DELETE' });
        showMsg('削除しました');
        card.remove();
      } catch (err) {
        showMsg(`削除に失敗: ${err.message}`);
      }
    });
    card.appendChild(el('div', { className: 'actions' }, [editBtn, delBtn]));
  };
  view();
  return card;
}

// pet が null なら新規追加。onSaved / onCancel で後処理を差し替える
function petForm(card, c, pets, p, onSaved, onCancel) {
  card.innerHTML = '';
  const nameIn = el('input', { value: p?.name ?? '', placeholder: 'お名前（必須）' });
  const breedIn = el('input', { value: p?.breed ?? '', placeholder: '犬種（例: トイプードル）' });
  const bdayIn = el('input', { type: 'date', value: dateValue(p?.birthday) });
  const notesIn = el('textarea', { value: p?.notes ?? '', placeholder: 'メモ（カットの好み・性格・注意点など）' });

  const form = el('form', {}, [nameIn, breedIn, bdayIn, notesIn]);
  form.addEventListener('submit', (e) => e.preventDefault());
  card.appendChild(form);

  const saveBtn = el('button', { type: 'button', textContent: '保存' });
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    const payload = {
      name: nameIn.value,
      breed: breedIn.value,
      birthday: bdayIn.value || null,
      notes: notesIn.value,
    };
    try {
      if (p) {
        await api(`/pets/${p.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
        Object.assign(p, { ...payload, name: payload.name.trim() });
      } else {
        await api(`/customers/${c.id}/pets`, { method: 'POST', body: JSON.stringify(payload) });
      }
      showMsg('ペット情報を保存しました');
      onSaved();
    } catch (err) {
      const messages = { invalid_name: 'ペットのお名前を入力してください', invalid_birthday: '誕生日の形式が不正です' };
      showMsg(messages[err.message] ?? `エラー: ${err.message}`);
      saveBtn.disabled = false;
    }
  });
  const cancelBtn = el('button', { type: 'button', className: 'ghost', textContent: '取消' });
  cancelBtn.addEventListener('click', onCancel);
  card.appendChild(el('div', { className: 'actions' }, [saveBtn, cancelBtn]));
}

// 追加・削除後にペット一覧を取り直して開いているカードを再描画する
async function refreshPets(body, c) {
  try {
    const { pets } = await api(`/customers/${c.id}/pets`);
    renderBody(body, c, pets);
  } catch (err) {
    showMsg(`再読み込みに失敗: ${err.message}`);
  }
}

document.getElementById('search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  loadCustomers().catch((err) => showMsg(`エラー: ${err.message}`));
});
loadCustomers().catch((err) => showMsg(`エラー: ${err.message}`));
