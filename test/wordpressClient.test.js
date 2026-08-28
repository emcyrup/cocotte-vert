import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createWordPressClient, splitCaption, buildContent,
} from '../src/wordpress/client.js';

const config = (over = {}) => ({
  wordpress: {
    baseUrl: 'https://example.test',
    user: 'editor',
    appPassword: 'abcd EFGH ijkl',
    status: 'draft',
    postMode: 'live',
    ...over,
  },
});

/** 呼ばれた fetch を記録し、決められた順に返す */
function makeFetch(responses) {
  const calls = [];
  const queue = [...responses];
  return {
    calls,
    fetchFn: async (url, opts = {}) => {
      calls.push({ url, opts });
      const next = queue.shift() ?? { ok: true, json: {} };
      if (next.throws) throw new Error(next.throws);
      return {
        ok: next.ok !== false,
        status: next.status ?? (next.ok === false ? 500 : 200),
        json: async () => next.json ?? {},
        arrayBuffer: async () => next.bytes ?? new Uint8Array([1, 2, 3]).buffer,
      };
    },
  };
}

// ---- タイトルと本文の切り分け ----

test('1行目をタイトル、残りを本文にする', () => {
  assert.deepEqual(splitCaption('今日のトリミング\n\nマロンちゃんが来てくれました。\nさっぱりしました。'), {
    title: '今日のトリミング',
    body: 'マロンちゃんが来てくれました。\nさっぱりしました。',
  });
});

test('1行しかなければ、それをタイトルにも本文にも使う', () => {
  // タイトルだけの記事は一覧で中身が分からない
  assert.deepEqual(splitCaption('本日も元気に営業中です'), {
    title: '本日も元気に営業中です',
    body: '本日も元気に営業中です',
  });
});

test('1行目が長すぎるときはタイトルを切り、本文には全文を残す', () => {
  const long = 'あ'.repeat(80);
  const result = splitCaption(long);
  assert.equal(result.title.length, 60);
  assert.match(result.title, /…$/);
  assert.equal(result.body, long, '情報を落とさない');
});

test('空の本文は空で返す（呼び出し側で弾く）', () => {
  assert.deepEqual(splitCaption('   '), { title: '', body: '' });
  assert.deepEqual(splitCaption(null), { title: '', body: '' });
});

// ---- 本文の組み立て ----

test('行ごとに段落にし、画像を後ろへ並べる', () => {
  const html = buildContent('一行目\n\n二行目', ['https://example.test/a.jpg']);
  assert.equal(
    html,
    '<p>一行目</p>\n<p>二行目</p>\n'
      + '<figure class="wp-block-image"><img src="https://example.test/a.jpg" alt="" /></figure>'
  );
});

test('HTML として解釈される文字を打ち消す', () => {
  const html = buildContent('<script>alert(1)</script> & "引用"', []);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&amp;/);
});

test('写真ゼロなら段落だけの記事になる', () => {
  assert.equal(buildContent('本日は休業します', []), '<p>本日は休業します</p>');
});

test('裸の URL をリンクにする（WordPress は本文中の URL を自動ではリンクにしない）', () => {
  assert.equal(
    buildContent('詳しくは https://example.com/news をご覧ください', []),
    '<p>詳しくは <a href="https://example.com/news">https://example.com/news</a> をご覧ください</p>'
  );
});

test('URL の直後の句読点はリンクに含めない', () => {
  const html = buildContent('https://example.com/a です。', []);
  assert.match(html, /href="https:\/\/example\.com\/a"/);
  assert.match(html, /<\/a> です。<\/p>/);

  // 英文の文末ピリオドも URL の一部にしない
  assert.match(buildContent('see https://example.com.', []), /href="https:\/\/example\.com"/);
});

test('クエリ文字列を持つ URL でも壊れない', () => {
  const html = buildContent('https://example.com/p?a=1&b=2', []);
  // & はエスケープ後 &amp; になるが、href の中では &amp; が正しい書き方
  assert.equal(html, '<p><a href="https://example.com/p?a=1&amp;b=2">https://example.com/p?a=1&amp;b=2</a></p>');
});

test('URL に見せかけた HTML は、リンクにも href にも取り込まない', () => {
  const html = buildContent('https://example.com/"><script>alert(1)</script>', []);
  // href は引用符の手前で切れる。属性から抜け出す足がかりを残さない
  assert.match(html, /^<p><a href="https:\/\/example\.com\/">/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

// ---- 投稿 ----

test('dry_run では何も送らない', async () => {
  const { fetchFn, calls } = makeFetch([]);
  const client = createWordPressClient({ config: config({ postMode: 'dry_run' }), fetchFn });

  const result = await client.publishPost({ imageUrls: ['https://x/a.jpg'], caption: '題\n本文' });

  assert.deepEqual(result, { status: 'dry_run' });
  assert.equal(calls.length, 0, '設定があっても送らない');
});

test('写真をメディアへ入れてから記事にする', async () => {
  const { fetchFn, calls } = makeFetch([
    { json: {} },                                             // 画像の取得
    { json: { id: 11, source_url: 'https://example.test/wp/a.jpg' } }, // メディア登録
    { json: { id: 99 } },                                     // 記事作成
  ]);
  const client = createWordPressClient({ config: config(), fetchFn });

  const result = await client.publishPost({
    imageUrls: ['https://ours.test/sns-media/a.jpg'],
    caption: '今日のできごと\n本文です',
  });

  assert.deepEqual(result, { status: 'published', mediaId: '99' });

  // 1回目: 自分のサーバーから画像を取ってくる
  assert.equal(calls[0].url, 'https://ours.test/sns-media/a.jpg');
  // 2回目: WordPress のメディアへ入れる
  assert.equal(calls[1].url, 'https://example.test/wp-json/wp/v2/media');
  assert.match(calls[1].opts.headers['Content-Disposition'], /filename="a\.jpg"/);
  // 3回目: 記事。本文には**WordPress 側の URL**が入る（自分のサーバーを参照しない）
  const body = JSON.parse(calls[2].opts.body);
  assert.equal(calls[2].url, 'https://example.test/wp-json/wp/v2/posts');
  assert.equal(body.title, '今日のできごと');
  assert.match(body.content, /https:\/\/example\.test\/wp\/a\.jpg/);
  assert.doesNotMatch(body.content, /ours\.test/, 'こちらのサーバーの URL を残さない');
  assert.equal(body.featured_media, 11, '1枚目をアイキャッチにする');
  assert.equal(body.status, 'draft');
});

test('写真が無くても記事は作れる', async () => {
  const { fetchFn, calls } = makeFetch([{ json: { id: 5 } }]);
  const client = createWordPressClient({ config: config(), fetchFn });

  const result = await client.publishPost({ imageUrls: [], caption: '題\n本文' });

  assert.equal(result.status, 'published');
  assert.equal(calls.length, 1, '記事の作成だけ');
  assert.equal(JSON.parse(calls[0].opts.body).featured_media, undefined);
});

test('画像の登録に失敗したら記事を作らない', async () => {
  const { fetchFn, calls } = makeFetch([
    { json: {} },                              // 画像の取得は成功
    { ok: false, status: 413, json: { message: 'too large' } },  // メディア登録で失敗
  ]);
  const client = createWordPressClient({ config: config(), fetchFn });

  await assert.rejects(
    () => client.publishPost({ imageUrls: ['https://ours.test/a.jpg'], caption: '題\n本文' }),
    /WordPress API 413: too large/
  );
  // 画像の抜けた記事が公開されるより、作られない方が気付ける
  assert.equal(calls.length, 2, '記事の作成まで進まない');
});

test('自分のサーバーから画像を取れないときも記事を作らない', async () => {
  const { fetchFn } = makeFetch([{ ok: false, status: 404 }]);
  const client = createWordPressClient({ config: config(), fetchFn });

  await assert.rejects(
    () => client.publishPost({ imageUrls: ['https://ours.test/none.jpg'], caption: '題\n本文' }),
    /画像を取得できません（404）/
  );
});

test('本文が空なら投稿しない', async () => {
  const { fetchFn, calls } = makeFetch([]);
  const client = createWordPressClient({ config: config(), fetchFn });
  await assert.rejects(() => client.publishPost({ caption: '  ' }), /本文がありません/);
  assert.equal(calls.length, 0);
});

// ---- 設定 ----

test('設定が足りなければ enabled は false', () => {
  for (const over of [{ baseUrl: null }, { user: null }, { appPassword: null }]) {
    assert.equal(createWordPressClient({ config: config(over) }).enabled, false, JSON.stringify(over));
  }
  assert.equal(createWordPressClient({ config: config() }).enabled, true);
});

test('設定が足りないまま live で投稿しようとしたら止める', async () => {
  const { fetchFn } = makeFetch([]);
  const client = createWordPressClient({ config: config({ user: null }), fetchFn });
  await assert.rejects(() => client.publishPost({ caption: '題\n本文' }), /設定が足りません/);
});

test('末尾のスラッシュはどちらで書かれても動く', async () => {
  const { fetchFn, calls } = makeFetch([{ json: { id: 1 } }]);
  const client = createWordPressClient({ config: config({ baseUrl: 'https://example.test/' }), fetchFn });

  await client.publishPost({ caption: '題\n本文' });

  assert.equal(calls[0].url, 'https://example.test/wp-json/wp/v2/posts');
});

test('アプリケーションパスワードで Basic 認証する', async () => {
  const { fetchFn, calls } = makeFetch([{ json: { id: 1 } }]);
  const client = createWordPressClient({ config: config(), fetchFn });

  await client.publishPost({ caption: '題\n本文' });

  const expected = `Basic ${Buffer.from('editor:abcd EFGH ijkl').toString('base64')}`;
  assert.equal(calls[0].opts.headers.Authorization, expected);
});

test('接続確認は読み取りだけで、ログイン名を返す', async () => {
  const { fetchFn, calls } = makeFetch([{ json: { name: '店長', slug: 'tencho' } }]);
  const client = createWordPressClient({ config: config(), fetchFn });

  assert.deepEqual(await client.whoAmI(), { name: '店長', slug: 'tencho' });
  assert.equal(calls[0].opts.method, 'GET');
});
