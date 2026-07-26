// LIFF 登録フォーム。userId はクライアントから送らず、ID トークンをサーバで検証させる。
const statusEl = document.getElementById('status');
const submitBtn = document.getElementById('submit');

function showStatus(message, kind) {
  statusEl.textContent = message;
  statusEl.className = kind;
}

async function main() {
  // LIFF ID はサーバから取得する（HTML に焼き込まない）
  const res = await fetch('./config');
  if (!res.ok) throw new Error('設定の取得に失敗しました');
  const { liffId } = await res.json();

  await liff.init({ liffId });
  if (!liff.isLoggedIn()) {
    liff.login();
    return;
  }

  document.getElementById('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    submitBtn.disabled = true;
    showStatus('送信中…', '');
    try {
      const idToken = liff.getIDToken();
      const body = {
        idToken,
        name: document.getElementById('name').value,
        phone: document.getElementById('phone').value,
        birthday: document.getElementById('birthday').value || null,
        consent: document.getElementById('consent').checked,
      };
      const resp = await fetch('./register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      if (!resp.ok || !data.ok) {
        const messages = {
          invalid_phone: '電話番号の形式をご確認ください。',
          invalid_name: 'お名前を入力してください。',
          invalid_birthday: '誕生日の形式をご確認ください。',
        };
        showStatus(messages[data.error] || '登録に失敗しました。時間をおいてお試しください。', 'error');
        submitBtn.disabled = false;
        return;
      }
      showStatus('ご登録ありがとうございました。この画面は閉じて構いません。', 'ok');
      // LIFF ブラウザ内ならウィンドウを閉じる
      setTimeout(() => { if (liff.isInClient()) liff.closeWindow(); }, 1500);
    } catch (err) {
      showStatus('通信エラーが発生しました。時間をおいてお試しください。', 'error');
      submitBtn.disabled = false;
    }
  });
}

main().catch(() => showStatus('初期化に失敗しました。LINE アプリから開き直してください。', 'error'));
