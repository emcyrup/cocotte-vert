import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSnsPublisher } from '../src/jobs/snsPublisher.js';

function makeFakes({ post = { id: 1, caption: 'c' }, photos = ['a'.repeat(24) + '.jpg'] } = {}) {
  const queries = [];
  const published = [];
  const notifications = [];
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/SET status = 'publishing'/.test(sql)) {
        return { rows: post ? [post] : [] };
      }
      if (/SELECT file FROM sns_photos/.test(sql)) {
        return { rows: photos.map((f) => ({ file: f })) };
      }
      if (/WHERE status = 'scheduled' AND scheduled_at/.test(sql)) {
        return { rows: post ? [{ id: post.id }] : [] };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  const instagram = {
    publishPost: async (args) => {
      published.push(args);
      return { status: 'published', mediaId: `m-${published.length}` };
    },
  };
  const slack = { notify: async (text) => notifications.push(text) };
  const config = { publicBaseUrl: 'https://example.com' };
  return { pool, instagram, slack, config, queries, published, notifications };
}

test('公開 URL を組み立てて投稿し、published へ更新する', async () => {
  const f = makeFakes();
  const publisher = createSnsPublisher(f);

  const result = await publisher.publishOne(1);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'published');
  assert.match(f.published[0].imageUrls[0], /^https:\/\/example\.com\/sns-media\/a{24}\.jpg$/);

  const update = f.queries.find((q) => /SET status = \$2, published_at/.test(q.sql));
  assert.equal(update.params[1], 'published');
  assert.equal(update.params[2], 'm-1');
});

test('11枚以上は2回に分けて投稿され、media_ids が両方記録される', async () => {
  const photos = Array.from({ length: 12 }, (_, i) => `${String(i).padStart(24, '0')}.jpg`.slice(-28));
  const f = makeFakes({ photos: Array.from({ length: 12 }, (_, i) => 'b'.repeat(24) + '.jpg') });
  const publisher = createSnsPublisher(f);

  const result = await publisher.publishOne(1);
  assert.equal(result.parts, 2);
  assert.equal(f.published.length, 2);
  assert.equal(f.published[0].imageUrls.length, 10);
  assert.equal(f.published[1].imageUrls.length, 2);
  assert.match(f.published[1].caption, /つづき（2\/2）/);

  const update = f.queries.find((q) => /SET status = \$2, published_at/.test(q.sql));
  assert.equal(update.params[2], 'm-1,m-2');
  void photos;
});

test('dry_run の結果は published ではなく dry_run として記録する', async () => {
  const f = makeFakes();
  f.instagram.publishPost = async () => ({ status: 'dry_run' });
  const publisher = createSnsPublisher(f);

  const result = await publisher.publishOne(1);
  assert.equal(result.status, 'dry_run');
  const update = f.queries.find((q) => /SET status = \$2, published_at/.test(q.sql));
  assert.equal(update.params[1], 'dry_run');
});

test('投稿失敗は failed に更新し、スタッフへ通知する', async () => {
  const f = makeFakes();
  f.instagram.publishPost = async () => {
    throw new Error('Instagram API 400: Invalid image');
  };
  const publisher = createSnsPublisher(f);

  const result = await publisher.publishOne(1);
  assert.equal(result.ok, false);
  const update = f.queries.find((q) => /SET status = 'failed'/.test(q.sql));
  assert.match(update.params[1], /Invalid image/);
  assert.equal(f.notifications.length, 1);
  assert.match(f.notifications[0], /Instagram 投稿に失敗/);
});

test('他プロセスが処理中（claim できない）なら何もしない', async () => {
  const f = makeFakes({ post: null });
  const publisher = createSnsPublisher(f);

  const result = await publisher.publishOne(1);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'not_publishable');
  assert.equal(f.published.length, 0);
});

test('publicBaseUrl 未設定では投稿せず failed にする', async () => {
  const f = makeFakes();
  f.config.publicBaseUrl = null;
  const publisher = createSnsPublisher(f);

  const result = await publisher.publishOne(1);
  assert.equal(result.ok, false);
  assert.match(result.error, /PUBLIC_BASE_URL/);
  assert.equal(f.published.length, 0);
});
