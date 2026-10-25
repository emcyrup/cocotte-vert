// 応答ヘッダとリクエスト元の確認。helmet などは入れず、要るものだけを手で付ける
// （依存を増やさない方針のため。必要なのは数行で済む）。

// 管理画面と管理 API。ここは Basic 認証の内側で、押すとお客様へ LINE が届く操作がある
const ADMIN_PATHS = ['/mock', '/api/admin'];
const isAdminPath = (p) => ADMIN_PATHS.some((a) => p === a || p.startsWith(`${a}/`));

/**
 * 全体に付けるヘッダ。
 *
 * nosniff は全ルートに付ける。写真（/sns-media）は認証なしで配っているので、
 * 中身が画像でなくてもブラウザに HTML として解釈させないため。
 *
 * 枠への埋め込み禁止は**管理画面だけ**に付ける。透明な枠で管理画面を重ねて
 * 「承認」ボタンを押させる手口（クリックジャッキング）を防ぐ。
 * LIFF 画面は LINE の中で開くので、念のため対象から外している（壊すと予約が受けられない）。
 */
export function securityHeaders() {
  return (req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    if (isAdminPath(req.path)) {
      res.setHeader('X-Frame-Options', 'DENY');
      // 画面は1枚の HTML にスクリプトを直書きしているので、script-src は絞らない
      // （絞ると画面が動かない）。埋め込みと外部への送信先だけを縛る
      res.setHeader(
        'Content-Security-Policy',
        "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'"
      );
    }
    next();
  };
}

// 書き込みを伴うメソッド。GET / HEAD / OPTIONS は何も変えないので通す
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * 他のサイトから送られてきた書き込みを断る（CSRF 対策）。
 *
 * 管理 API は Basic 認証。ブラウザは一度入力した Basic 認証を、**別のサイトから
 * 送られたリクエストにも自動で付ける**（Cookie の SameSite のような仕組みが無い）。
 * スタッフが悪意のあるページを開いただけで、管理画面の操作を実行されうる。
 *
 * 判定にはブラウザが付ける Sec-Fetch-Site を使う。ページ側からは書き換えられない。
 * Origin と Host を比べる方法はプロキシの設定（Host を転送しているか）に左右され、
 * 本番の Nginx は管理会社の持ち物で確かめられないので採らない。
 *
 * ヘッダが無いリクエスト（curl・GitHub Actions からの EPARK 反映・スクリプト）は通す。
 * これらはブラウザではないので、保存された認証を勝手に付けられることがない。
 */
export function rejectCrossSite() {
  return (req, res, next) => {
    if (!UNSAFE.has(req.method)) return next();
    const site = req.get('Sec-Fetch-Site');
    // same-origin: 管理画面から。none: 利用者自身の操作（アドレス欄など）
    if (!site || site === 'same-origin' || site === 'none') return next();
    console.warn(`[security] 他サイトからの書き込みを断りました（${req.method} ${req.path} / ${site}）`);
    return res.status(403).json({ error: 'cross_site_request' });
  };
}
