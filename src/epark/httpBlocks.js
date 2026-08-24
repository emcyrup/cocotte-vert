// 「未反映の作業」を、データベースではなく**管理 API 越し**に読み書きする。
//
// ブラウザ（Chromium）とデータベースの両方に届く場所が無い、という事情のため。
//   GitHub Actions … ブラウザはあるが、データベースには届かない
//   アプリサーバー … データベースには届くが、ブラウザを置けない（sudo なし）
//
// そこで自動化は GitHub Actions で動かし、作業の一覧と消し込みは HTTP で行う。
// `reservations/externalBlock.js` と同じ形（listPending / setDone）を返すので、
// `epark/sync.js` からはどちらを渡しても同じように動く。
//
// 取ってくるのは `?fields=sync`。**お客様の氏名・電話番号は含まれない。**

const TIMEOUT_MS = 20_000;

export function createHttpBlocks({ baseUrl, user, password, fetchFn = fetch }) {
  const root = String(baseUrl).replace(/\/$/, '');
  const headers = {
    // 管理画面と同じ Basic 認証。資格情報は GitHub Secrets から渡す
    Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`,
    'Content-Type': 'application/json',
  };

  async function call(path, options = {}) {
    const res = await fetchFn(`${root}${path}`, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      ...options,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const why = body.error || `HTTP ${res.status}`;
      // 認証の失敗はここで分かるようにする。原因が分からないまま黙って0件になると困る
      throw new Error(res.status === 401 ? '管理画面にログインできません（ADMIN_USER / ADMIN_PASSWORD）' : why);
    }
    return body;
  }

  async function listPending() {
    const { toBlock = [], toRelease = [] } = await call('/api/admin/external-blocks?fields=sync');
    return { toBlock, toRelease };
  }

  async function setDone({ id, done, cells = null }) {
    if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'invalid_id' };
    try {
      return await call(`/api/admin/external-blocks/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ done: Boolean(done), cells }),
      });
    } catch (err) {
      // 記録できなければ済みにしない。sync 側が失敗として扱い、チェックリストに残す
      return { ok: false, error: err.message };
    }
  }

  return { listPending, setDone };
}
