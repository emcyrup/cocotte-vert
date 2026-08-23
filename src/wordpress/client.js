// WordPress への投稿（REST API v2）。
//
// 認証は「アプリケーションパスワード」の Basic 認証を使う。通常のログインパスワードは使わない
// （WordPress 側でアプリごとに発行・失効できるため）。
//
// **写真は WordPress のメディアライブラリへ入れてから記事に載せる。**
// こちらのサーバーの URL をそのまま <img> で参照すると、サーバーを移したり止めたりした
// ときに過去の記事の画像が全部消える。実際に本番サーバーの移設が控えているため、
// 記事側で完結するようにしてある。
//
// 記事にはタイトルが要るが、SNS のキャプションは本文だけ。**1行目をタイトル、
// 残りを本文**として扱う。1行しかなければ、それをタイトルにして本文は空にしない
// （タイトルだけの記事は一覧で中身が分からないため）。

const API = '/wp-json/wp/v2';
// 記事タイトルの上限。長すぎる1行目をそのまま入れると一覧で崩れる
const MAX_TITLE = 60;

/** 1行目をタイトル、残りを本文にする */
export function splitCaption(caption) {
  const text = String(caption ?? '').trim();
  if (!text) return { title: '', body: '' };

  const [first, ...rest] = text.split('\n');
  const body = rest.join('\n').trim();
  // 1行目が長すぎるときはタイトルを切り、本文には全文を残す（情報を落とさない）
  if (first.length > MAX_TITLE) {
    return { title: `${first.slice(0, MAX_TITLE - 1)}…`, body: text };
  }
  return { title: first, body: body || first };
}

/** 段落と画像を並べた記事本文（WordPress のブロックエディタでも素直に表示される） */
export function buildContent(body, mediaUrls) {
  const paragraphs = String(body ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => `<p>${escapeHtml(l)}</p>`);
  const images = mediaUrls.map(
    (url) => `<figure class="wp-block-image"><img src="${escapeHtml(url)}" alt="" /></figure>`
  );
  return [...paragraphs, ...images].join('\n');
}

const escapeHtml = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export function createWordPressClient({ config, fetchFn = fetch }) {
  const wp = config.wordpress ?? {};
  // 末尾のスラッシュはどちらで書かれても動くようにする
  const base = wp.baseUrl ? wp.baseUrl.replace(/\/+$/, '') : null;
  const enabled = Boolean(base && wp.user && wp.appPassword);

  const auth = () =>
    `Basic ${Buffer.from(`${wp.user}:${wp.appPassword}`).toString('base64')}`;

  async function api(path, { method = 'POST', headers = {}, body }) {
    const res = await fetchFn(`${base}${API}${path}`, {
      method,
      headers: { Authorization: auth(), ...headers },
      body,
      signal: AbortSignal.timeout(30000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`WordPress API ${res.status}: ${json.message ?? 'unknown'}`);
    }
    return json;
  }

  /** 画像を1枚メディアライブラリへ入れる。@returns {{id:number, url:string}} */
  async function uploadMedia(imageUrl) {
    const res = await fetchFn(imageUrl, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`画像を取得できません（${res.status}）: ${imageUrl}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    // 拡張子は投稿画像の実体に合わせる（このシステムは JPEG のみ受け付けている）
    const name = imageUrl.split('/').pop()?.split('?')[0] || 'photo.jpg';

    const media = await api('/media', {
      headers: {
        'Content-Type': 'image/jpeg',
        'Content-Disposition': `attachment; filename="${name}"`,
      },
      body: bytes,
    });
    return { id: media.id, url: media.source_url };
  }

  /** 接続確認（読み取りのみ）。ログイン名を返す */
  async function whoAmI() {
    if (!enabled) throw new Error('WordPress の設定が足りません');
    const me = await api('/users/me?context=edit', { method: 'GET' });
    return { name: me.name, slug: me.slug };
  }

  async function publishPost({ imageUrls = [], caption }) {
    const { title, body } = splitCaption(caption);
    if (!title) throw new Error('本文がありません');

    if (wp.postMode !== 'live') {
      console.log(
        `[dry_run wordpress] ${imageUrls.length}枚 / ${wp.status}\n` +
          `title: ${title}\n${body}\n${imageUrls.join('\n')}`
      );
      return { status: 'dry_run' };
    }
    if (!enabled) throw new Error('WordPress の設定が足りません');

    // 画像を先に入れる。1枚でも失敗したら記事を作らない
    // （画像の抜けた記事が公開されるより、作られない方が気付ける）
    const media = [];
    for (const url of imageUrls) media.push(await uploadMedia(url));

    const post = await api('/posts', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        content: buildContent(body, media.map((m) => m.url)),
        status: wp.status,
        // 1枚目をアイキャッチにする。一覧やSNSシェアで使われる
        ...(media.length > 0 ? { featured_media: media[0].id } : {}),
      }),
    });
    return { status: 'published', mediaId: String(post.id) };
  }

  return { publishPost, whoAmI, enabled };
}
