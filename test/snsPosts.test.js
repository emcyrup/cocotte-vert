// 投稿の作成 API。ここでは「写真が要るか」の判定だけを見る。
// 投稿先ごとの決まりは src/sns/platforms.js が唯一の出どころで、
// 一度この API がそれを見ずに写真ゼロを一律で弾いていた（WordPress は
// photoRequired: false なのに写真なしで投稿できなかった）ので、その回帰を止める。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createSnsRouter } from '../src/http/snsRoutes.js';

const FILE_A = 'a'.repeat(24) + '.jpg';

async function withServer(app, fn) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

function withRouter(fn) {
  const inserted = [];
  const client = {
    query: async (sql, params) => {
      inserted.push({ sql, params });
      return /INSERT INTO sns_posts/.test(sql) ? { rows: [{ id: 42 }] } : { rows: [] };
    },
    release: () => {},
  };
  const published = [];
  const app = express();
  app.use(express.json());
  app.use('/api/admin/sns', createSnsRouter({
    pool: { connect: async () => client, query: async () => ({ rows: [] }) },
    publisher: { publishOne: async (id) => { published.push(id); return { ok: true, status: 'published' }; } },
    dataDir: '/tmp',
  }));
  return withServer(app, (base) => fn(base, { inserted, published }));
}

const create = (base, body) =>
  fetch(`${base}/api/admin/sns/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

test('写真が要らない投稿先は、本文だけで投稿できる', async () => {
  await withRouter(async (base, state) => {
    const res = await create(base, {
      platform: 'wordpress',
      caption: '夏の営業について\n8/13〜16はお休みします\nhttps://example.com/news',
      files: [],
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, postId: 42, status: 'published' });

    // 写真の行は1つも作らない
    assert.equal(state.inserted.some((q) => /INSERT INTO sns_photos/.test(q.sql)), false);
    assert.deepEqual(state.published, [42]);
  });
});

test('files を省いても写真なしとして扱う', async () => {
  await withRouter(async (base) => {
    const res = await create(base, { platform: 'wordpress', caption: 'お知らせ' });
    assert.equal(res.status, 200);
  });
});

test('写真が要る投稿先は、これまでどおり写真なしを弾く', async () => {
  await withRouter(async (base, state) => {
    for (const platform of ['instagram', 'threads']) {
      const res = await create(base, { platform, caption: '本文', files: [] });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error, 'no_photos');
    }
    assert.equal(state.published.length, 0);
  });
});

test('写真も本文も無い投稿は作らせない', async () => {
  await withRouter(async (base, state) => {
    for (const caption of [undefined, '', '   ']) {
      const res = await create(base, { platform: 'wordpress', caption, files: [] });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error, 'invalid_caption');
    }
    assert.equal(state.published.length, 0);
  });
});

test('写真ありの投稿はこれまでどおり写真の行を作る', async () => {
  await withRouter(async (base, state) => {
    const res = await create(base, { platform: 'wordpress', caption: '本文', files: [FILE_A] });
    assert.equal(res.status, 200);
    const photo = state.inserted.find((q) => /INSERT INTO sns_photos/.test(q.sql));
    assert.deepEqual(photo.params, [42, FILE_A, 0]);
  });
});

test('知らない投稿先は弾く', async () => {
  await withRouter(async (base) => {
    const res = await create(base, { platform: 'mixi', caption: '本文', files: [] });
    assert.equal((await res.json()).error, 'invalid_platform');
  });
});
