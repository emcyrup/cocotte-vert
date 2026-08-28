import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { createSnsRouter } from '../src/http/snsRoutes.js';

const FILE_A = 'a'.repeat(24) + '.jpg';
const FILE_B = 'b'.repeat(24) + '.jpg';

// supertest は入れずに、実際にポートを開いて fetch で叩く（依存を増やさない）
async function withServer(app, fn) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    server.close();
  }
}

async function withRouter({ writer = null }, fn) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'sns-'));
  await writeFile(path.join(dataDir, FILE_A), Buffer.from([0xff, 0xd8, 0x01]));
  await writeFile(path.join(dataDir, FILE_B), Buffer.from([0xff, 0xd8, 0x02]));

  const app = express();
  app.use(express.json());
  app.use('/api/admin/sns', createSnsRouter({
    pool: { query: async () => ({ rows: [] }) },
    publisher: {},
    dataDir,
    captionWriter: writer,
    storeName: 'テスト店',
  }));
  try {
    return await withServer(app, (base) => fn(base, dataDir));
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

const post = (base, body) =>
  fetch(`${base}/api/admin/sns/caption`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

// 呼ばれた引数を記録しつつ、決め打ちの結果を返す writer
function fakeWriter(result = { caption: '下書きです' }) {
  const calls = [];
  return {
    calls,
    writer: {
      write: async (args) => {
        calls.push(args);
        if (result instanceof Error) throw result;
        return result;
      },
    },
  };
}

test('写真を読み込んで下書きを返す', async () => {
  const { writer, calls } = fakeWriter();
  await withRouter({ writer }, async (base) => {
    const res = await post(base, { files: [FILE_A, FILE_B], platform: 'instagram', hint: '遠足' });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, caption: '下書きです' });

    assert.equal(calls[0].images.length, 2);
    assert.equal(calls[0].images[0].mediaType, 'image/jpeg');
    // ファイルの中身が base64 で渡っている
    assert.equal(calls[0].images[0].data, Buffer.from([0xff, 0xd8, 0x01]).toString('base64'));
    assert.equal(calls[0].platform, 'instagram');
    assert.equal(calls[0].hint, '遠足');
    assert.equal(calls[0].storeName, 'テスト店');
  });
});

test('API キー未設定（writer なし）なら 503', async () => {
  await withRouter({ writer: null }, async (base) => {
    const res = await post(base, { files: [FILE_A] });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, 'no_api_key');
  });
});

test('写真が要る投稿先で写真なし・枚数超過は 400', async () => {
  const { writer, calls } = fakeWriter();
  await withRouter({ writer }, async (base) => {
    assert.equal((await (await post(base, { files: [] })).json()).error, 'no_photos');
    const many = Array.from({ length: 21 }, () => FILE_A);
    assert.equal((await (await post(base, { files: many })).json()).error, 'too_many_photos');
    assert.equal(calls.length, 0);
  });
});

test('写真が要らない投稿先は、要点だけで下書きできる', async () => {
  const { writer, calls } = fakeWriter({ caption: '記事の下書き' });
  await withRouter({ writer }, async (base) => {
    const res = await post(base, {
      files: [], platform: 'wordpress', hint: 'お盆休み 8/13-16 https://example.com/news',
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).caption, '記事の下書き');

    assert.deepEqual(calls[0].images, []);
    assert.equal(calls[0].hint, 'お盆休み 8/13-16 https://example.com/news');
  });
});

test('写真も要点も無ければ、写真が要らない投稿先でも書けない', async () => {
  const { writer, calls } = fakeWriter();
  await withRouter({ writer }, async (base) => {
    for (const hint of [undefined, '', '   ']) {
      const res = await post(base, { files: [], platform: 'wordpress', hint });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error, 'no_notes');
    }
    // Instagram は写真が要るので、要点があっても写真なしでは書かない
    const ig = await post(base, { files: [], platform: 'instagram', hint: 'お知らせ' });
    assert.equal((await ig.json()).error, 'no_photos');
    assert.equal(calls.length, 0);
  });
});

test('要点は 1000 文字まで', async () => {
  const { writer, calls } = fakeWriter();
  await withRouter({ writer }, async (base) => {
    const ok = await post(base, { files: [], platform: 'wordpress', hint: 'あ'.repeat(1000) });
    assert.equal(ok.status, 200);

    const ng = await post(base, { files: [], platform: 'wordpress', hint: 'あ'.repeat(1001) });
    assert.equal((await ng.json()).error, 'invalid_hint');
    assert.equal(calls.length, 1);
  });
});

test('アップロード API が発行していないファイル名は弾く', async () => {
  const { writer, calls } = fakeWriter();
  await withRouter({ writer }, async (base) => {
    for (const bad of ['../../etc/passwd', 'foo.jpg', FILE_A.replace('.jpg', '.png')]) {
      const res = await post(base, { files: [bad] });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error, 'invalid_file');
    }
    assert.equal(calls.length, 0);
  });
});

test('不正なプラットフォーム・長すぎる補足は 400', async () => {
  const { writer } = fakeWriter();
  await withRouter({ writer }, async (base) => {
    assert.equal(
      (await (await post(base, { files: [FILE_A], platform: 'mixi' })).json()).error,
      'invalid_platform'
    );
    assert.equal(
      (await (await post(base, { files: [FILE_A], hint: 'あ'.repeat(1001) })).json()).error,
      'invalid_hint'
    );
  });
});

test('写真が消えていたら photo_missing', async () => {
  const { writer } = fakeWriter();
  await withRouter({ writer }, async (base) => {
    const res = await post(base, { files: ['c'.repeat(24) + '.jpg'] });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'photo_missing');
  });
});

test('生成側の失敗理由はそのままコードで返る', async () => {
  for (const [message, status] of [['refused', 400], ['bad_response', 400], ['api_error', 502]]) {
    const { writer } = fakeWriter(new Error(message));
    await withRouter({ writer }, async (base) => {
      const res = await post(base, { files: [FILE_A] });
      assert.equal(res.status, status);
      assert.equal((await res.json()).error, message);
    });
  }
});
