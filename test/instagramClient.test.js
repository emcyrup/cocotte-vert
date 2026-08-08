import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInstagramClient, splitIntoPosts } from '../src/instagram/client.js';

function makeFetch(responses = {}) {
  const calls = [];
  const fetchFn = async (url, options = {}) => {
    calls.push({ url, body: options.body ? Object.fromEntries(options.body) : null });
    const key = Object.keys(responses).find((k) => url.includes(k));
    const value = responses[key] ?? { id: `id-${calls.length}` };
    if (value.__status) {
      return { ok: false, status: value.__status, json: async () => value };
    }
    return { ok: true, status: 200, json: async () => value };
  };
  return { calls, fetchFn };
}

const liveConfig = {
  igPostMode: 'live',
  igUserId: '17840000000000000',
  igAccessToken: 'token-env',
  igGraphBase: 'https://graph.instagram.com',
};

test('dry_run では API を一切呼ばない', async () => {
  const { calls, fetchFn } = makeFetch();
  const client = createInstagramClient({
    config: { ...liveConfig, igPostMode: 'dry_run' },
    fetchFn,
  });

  const result = await client.publishPost({
    imageUrls: ['https://example.com/a.jpg'],
    caption: 'テスト',
  });
  assert.equal(result.status, 'dry_run');
  assert.equal(calls.length, 0);
});

test('1枚はコンテナ作成→公開の2段階で投稿される', async () => {
  const { calls, fetchFn } = makeFetch({ media_publish: { id: 'media-1' } });
  const client = createInstagramClient({ config: liveConfig, fetchFn });

  const result = await client.publishPost({
    imageUrls: ['https://example.com/a.jpg'],
    caption: '本日のようす',
  });

  assert.equal(result.status, 'published');
  assert.equal(result.mediaId, 'media-1');
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/media$/);
  assert.equal(calls[0].body.image_url, 'https://example.com/a.jpg');
  assert.equal(calls[0].body.caption, '本日のようす');
  assert.match(calls[1].url, /\/media_publish$/);
});

test('複数枚はカルーセルとして投稿される（各画像→束ね→公開）', async () => {
  const { calls, fetchFn } = makeFetch();
  const client = createInstagramClient({ config: liveConfig, fetchFn });

  const urls = ['https://e.com/1.jpg', 'https://e.com/2.jpg', 'https://e.com/3.jpg'];
  await client.publishPost({ imageUrls: urls, caption: 'c' });

  // 3枚のコンテナ + カルーセルコンテナ + 公開 = 5回
  assert.equal(calls.length, 5);
  assert.equal(calls[0].body.is_carousel_item, 'true');
  assert.equal(calls[3].body.media_type, 'CAROUSEL');
  assert.equal(calls[3].body.children, 'id-1,id-2,id-3');
  assert.equal(calls[3].body.caption, 'c');
});

test('11枚以上は publishPost では拒否される（分割は呼び出し側の責務）', async () => {
  const { fetchFn } = makeFetch();
  const client = createInstagramClient({ config: liveConfig, fetchFn });
  await assert.rejects(
    () => client.publishPost({ imageUrls: Array(11).fill('https://e.com/x.jpg'), caption: '' }),
    /10枚まで/
  );
});

test('API エラーはメッセージ付きで投げる', async () => {
  const { fetchFn } = makeFetch({
    media: { __status: 400, error: { message: 'Invalid image' } },
  });
  const client = createInstagramClient({ config: liveConfig, fetchFn });
  await assert.rejects(
    () => client.publishPost({ imageUrls: ['https://e.com/a.jpg'], caption: '' }),
    /Instagram API 400: Invalid image/
  );
});

test('トークンは DB（settings）を env より優先する', async () => {
  const { calls, fetchFn } = makeFetch();
  const settings = { get: async () => 'token-db', set: async () => {} };
  const client = createInstagramClient({ config: liveConfig, settings, fetchFn });

  await client.publishPost({ imageUrls: ['https://e.com/a.jpg'], caption: '' });
  assert.equal(calls[0].body.access_token, 'token-db');
});

test('refreshTokenIfNeeded: 前回から7日未満なら延長しない', async () => {
  const { calls, fetchFn } = makeFetch();
  const store = new Map([
    ['ig_access_token', 't'],
    ['ig_token_refreshed_at', new Date().toISOString()],
  ]);
  const settings = { get: async (k) => store.get(k) ?? null, set: async (k, v) => store.set(k, v) };
  const client = createInstagramClient({ config: liveConfig, settings, fetchFn });

  const result = await client.refreshTokenIfNeeded();
  assert.equal(result.refreshed, false);
  assert.equal(calls.length, 0);
});

test('refreshTokenIfNeeded: 7日経過で延長し、新トークンを保存する', async () => {
  const { calls, fetchFn } = makeFetch({ refresh_access_token: { access_token: 'new-token' } });
  const store = new Map([
    ['ig_access_token', 'old-token'],
    ['ig_token_refreshed_at', new Date(Date.now() - 8 * 86_400_000).toISOString()],
  ]);
  const settings = { get: async (k) => store.get(k) ?? null, set: async (k, v) => store.set(k, v) };
  const client = createInstagramClient({ config: liveConfig, settings, fetchFn });

  const result = await client.refreshTokenIfNeeded();
  assert.equal(result.refreshed, true);
  assert.equal(store.get('ig_access_token'), 'new-token');
  assert.match(calls[0].url, /refresh_access_token/);
  assert.match(calls[0].url, /old-token/);
});

// ---- 分割 ----

test('splitIntoPosts: 10枚以下は1投稿でキャプションそのまま', () => {
  const parts = splitIntoPosts(['a', 'b'], 'こんにちは');
  assert.equal(parts.length, 1);
  assert.deepEqual(parts[0].files, ['a', 'b']);
  assert.equal(parts[0].caption, 'こんにちは');
});

test('splitIntoPosts: 11枚以上は2投稿に分割し、2件目に「つづき」を追記する', () => {
  const files = Array.from({ length: 14 }, (_, i) => `f${i}`);
  const parts = splitIntoPosts(files, '本日のようす');
  assert.equal(parts.length, 2);
  assert.equal(parts[0].files.length, 10);
  assert.equal(parts[1].files.length, 4);
  assert.equal(parts[0].caption, '本日のようす');
  assert.equal(parts[1].caption, '本日のようす\n\nつづき（2/2）');
});

test('IG_USER_ID 未設定なら me で投稿する（トークンがアカウントを特定する）', async () => {
  const { calls, fetchFn } = makeFetch();
  const client = createInstagramClient({
    config: { ...liveConfig, igUserId: null },
    fetchFn,
  });

  await client.publishPost({ imageUrls: ['https://e.com/a.jpg'], caption: '' });
  assert.match(calls[0].url, /\/me\/media$/);
  assert.match(calls[1].url, /\/me\/media_publish$/);
});
