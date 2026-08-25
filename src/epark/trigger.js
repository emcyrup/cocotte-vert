// 予約が入った・変わった・取り消された、その場で EPARK への反映を走らせる。
//
// なぜアプリから直接 EPARK を触らないのか: **ブラウザを置ける場所がここではない**。
// 本番サーバーには sudo が無く Chromium を入れられないため、自動操作は GitHub Actions
// で動かしている（そちらはデータベースに届かないので、作業の一覧は管理 API 越しに取る）。
// つまり「即時」にできるのは、**向こうを今すぐ起こすこと**まで。
//
// 起こすだけなので、ここでは EPARK に何が起きるかを決めない。live か dry_run かは
// 向こうの設定（EPARK_SYNC_MODE）が持っている。**送信の3段階ガードと同じ考えで、
// 実際に書き換える判断は1か所にまとめておく。**
//
// 失敗しても予約の登録は止めない。30分ごとの定期実行が拾うので、遅れるだけで済む。

const API = 'https://api.github.com';

/**
 * @param {object} p
 * @param {object} p.config config.js の epark.trigger
 * @param {object} [p.slack] 通知先。起こせなかったことに気付けるようにする
 * @param {Function} [p.fetchFn] 差し替え用
 */
export function createEparkTrigger({ config, slack = null, fetchFn = fetch }) {
  const { enabled, repo, token, workflow, ref } = config ?? {};

  // 何度呼ばれても走るのは1本。予約が続けて入っても、一覧は毎回まるごと消化されるので
  // 「いま動いている」か「次が控えている」のどちらかがあれば、追加で起こす意味がない
  let running = null;
  let queued = false;

  // 通知部は notify を持つ（send ではない）。**ここを間違えて、失敗を伝えるはずの行が
  // 逆に例外を投げ、誰も待っていない約束の中で外へ出た**（実物で踏んだ）。
  // 名前を決め打ちせず、無ければ黙って諦める。知らせられないことより、
  // 知らせようとして落ちるほうが悪い
  const tell = async (text) => {
    const to = slack?.notify ?? slack?.send;
    if (typeof to !== 'function') return;
    await to.call(slack, text);
  };

  async function dispatch() {
    const res = await fetchFn(`${API}/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      // mode は渡さない。live かどうかは向こうの設定に委ねる（ガードを1か所に保つ）
      body: JSON.stringify({ ref, inputs: {} }),
    });
    if (!res.ok) {
      // 本文には token は入らないが、相手の返事をそのまま流すと何が混じるか読めない。
      // 切り分けに要るのは状態コードなので、それだけを残す
      throw new Error(`GitHub が受け付けませんでした（HTTP ${res.status}）`);
    }
  }

  /**
   * EPARK 反映を今すぐ走らせる。**待たない**（呼び出し側の処理を遅らせないため）。
   * @param {string} reason ログに残す理由。**お客様の情報は入れない**
   */
  function trigger(reason) {
    if (!enabled) return;
    if (running) {
      queued = true;   // 走っている最中の分は、終わったら1回だけまとめて起こす
      return;
    }
    running = dispatch()
      .then(() => { console.log(`[epark] 反映を走らせました（${reason}）`); })
      .catch((err) => {
        console.warn(`[epark] 反映を走らせられませんでした（${reason}）: ${err.message}`);
        // 気付けないまま遅れるのを避ける。定期実行が拾うので、止まりはしない
        return tell(
          `:warning: EPARK の即時反映を起動できませんでした（${reason}）\n`
          + `${err.message}\n定期実行（30分ごと）が拾うため、反映は遅れますが止まりません`
        );
      })
      .catch(() => {})   // ここから先へは何も出さない（誰も待っていない約束なので）
      .finally(() => {
        running = null;
        if (queued) { queued = false; trigger(`${reason}のあと`); }
      });
  }

  return trigger;
}

/** 設定が揃っていなければ null。呼び出し側は null をそのまま渡してよい */
export function eparkTriggerFrom({ config, slack = null, fetchFn = fetch }) {
  const t = config?.epark?.trigger;
  if (!t?.enabled) return null;
  return createEparkTrigger({ config: t, slack, fetchFn });
}
