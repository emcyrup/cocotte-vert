import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCaptionWriter } from '../src/ai/writeCaption.js';

function makeFetch(status, body) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { fetchFn, calls };
}

function apiResponse(obj, stopReason = 'end_turn') {
  return { stop_reason: stopReason, content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

const IMG = { mediaType: 'image/jpeg', data: 'AAAA' };
const images = (n) => Array.from({ length: n }, () => IMG);

test('本文とハッシュタグを1本の文字列にして返す', async () => {
  const { fetchFn } = makeFetch(200, apiResponse({
    caption: '今日もみんな元気でした🐾',
    hashtags: ['ここっとベール', '大阪トリミング'],
  }));
  const { write } = createCaptionWriter({ apiKey: 'key', fetchFn });
  const { caption } = await write({ images: images(1) });
  assert.equal(caption, '今日もみんな元気でした🐾\n\n#ここっとベール #大阪トリミング');
});

test('ハッシュタグの # と空白は整えられる', async () => {
  const { fetchFn } = makeFetch(200, apiResponse({
    caption: '本文', hashtags: ['#すでに付いている', '空白 入り', '', '  '],
  }));
  const { write } = createCaptionWriter({ apiKey: 'key', fetchFn });
  const { caption } = await write({ images: images(1) });
  assert.equal(caption, '本文\n\n#すでに付いている #空白入り');
});

test('上限を超えるときは本文より先にハッシュタグを落とす', async () => {
  const { fetchFn } = makeFetch(200, apiResponse({
    caption: 'あ'.repeat(480),
    hashtags: ['タグ'.repeat(10), 'タグ'.repeat(10), '短い'],
  }));
  const { write } = createCaptionWriter({ apiKey: 'key', fetchFn });
  const { caption } = await write({ images: images(1), platform: 'threads' });
  assert.ok(caption.length <= 500, `500文字以内: ${caption.length}`);
  // 本文はそのまま残る（途中で切れるほうが読み手には不自然なため）
  assert.ok(caption.startsWith('あ'.repeat(480)));
});

test('ハッシュタグを全部落としても長いときは本文を切る', async () => {
  const { fetchFn } = makeFetch(200, apiResponse({ caption: 'あ'.repeat(600), hashtags: ['タグ'] }));
  const { write } = createCaptionWriter({ apiKey: 'key', fetchFn });
  const { caption } = await write({ images: images(1), platform: 'threads' });
  assert.equal(caption.length, 500);
});

test('写真は多くても4枚しか送らない（等間隔で間引く）', async () => {
  const { fetchFn, calls } = makeFetch(200, apiResponse({ caption: '本文', hashtags: [] }));
  const { write } = createCaptionWriter({ apiKey: 'key', fetchFn });
  await write({ images: images(20) });

  const body = JSON.parse(calls[0].init.body);
  const sent = body.messages[0].content.filter((c) => c.type === 'image');
  assert.equal(sent.length, 4);
});

test('スタッフの補足は本文の指示に入る', async () => {
  const { fetchFn, calls } = makeFetch(200, apiResponse({ caption: '本文', hashtags: [] }));
  const { write } = createCaptionWriter({ apiKey: 'key', fetchFn });
  await write({ images: images(1), hint: '今日は保育コースの遠足' });

  const body = JSON.parse(calls[0].init.body);
  const text = body.messages[0].content.at(-1).text;
  assert.match(text, /今日は保育コースの遠足/);
});

test('店名とプラットフォームがシステムプロンプトに入る', async () => {
  const { fetchFn, calls } = makeFetch(200, apiResponse({ caption: '本文', hashtags: [] }));
  const { write } = createCaptionWriter({ apiKey: 'key', fetchFn });
  await write({ images: images(1), storeName: 'FREE WAN', platform: 'threads' });

  const body = JSON.parse(calls[0].init.body);
  assert.match(body.system, /FREE WAN/);
  assert.match(body.system, /スレッズ/);
});

test('構造化出力とモデル指定が入る', async () => {
  const { fetchFn, calls } = makeFetch(200, apiResponse({ caption: '本文', hashtags: [] }));
  const { write } = createCaptionWriter({ apiKey: 'key', model: 'claude-haiku-4-5', fetchFn });
  await write({ images: images(1) });

  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, 'claude-haiku-4-5');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.deepEqual(body.output_config.format.schema.required, ['caption', 'hashtags']);
  assert.equal(calls[0].init.headers['x-api-key'], 'key');
});

// ---- 失敗は握り潰さず、理由が分かる形で投げる ----

test('API キー未設定なら API を呼ばずに no_api_key', async () => {
  const { fetchFn, calls } = makeFetch(200, apiResponse({ caption: '本文', hashtags: [] }));
  const { write } = createCaptionWriter({ apiKey: null, fetchFn });
  await assert.rejects(() => write({ images: images(1) }), /no_api_key/);
  assert.equal(calls.length, 0);
});

test('写真ゼロなら API を呼ばずに no_images', async () => {
  const { fetchFn, calls } = makeFetch(200, apiResponse({ caption: '本文', hashtags: [] }));
  const { write } = createCaptionWriter({ apiKey: 'key', fetchFn });
  await assert.rejects(() => write({ images: [] }), /no_images/);
  assert.equal(calls.length, 0);
});

test('拒否されたときは refused', async () => {
  const { fetchFn } = makeFetch(200, { stop_reason: 'refusal', content: [] });
  const { write } = createCaptionWriter({ apiKey: 'key', fetchFn });
  await assert.rejects(() => write({ images: images(1) }), /refused/);
});

test('途中で切れたときは too_long', async () => {
  const { fetchFn } = makeFetch(200, apiResponse({ caption: '途中', hashtags: [] }, 'max_tokens'));
  const { write } = createCaptionWriter({ apiKey: 'key', fetchFn });
  await assert.rejects(() => write({ images: images(1) }), /too_long/);
});

test('API エラーは api_error', async () => {
  const { fetchFn } = makeFetch(500, { error: 'overloaded' });
  const { write } = createCaptionWriter({ apiKey: 'key', fetchFn });
  await assert.rejects(() => write({ images: images(1) }), /api_error/);
});

test('JSON として読めない・本文が空なら bad_response', async () => {
  for (const body of [
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'これはJSONではありません' }] },
    apiResponse({ caption: '   ', hashtags: [] }),
  ]) {
    const { fetchFn } = makeFetch(200, body);
    const { write } = createCaptionWriter({ apiKey: 'key', fetchFn });
    await assert.rejects(() => write({ images: images(1) }), /bad_response/);
  }
});

test('投稿先ごとに長さの指針と上限が変わる', async () => {
  const cases = [
    ['instagram', /120〜200文字/, 2200],
    ['threads', /60〜120文字/, 500],
    ['x', /60〜100文字/, 280],
    ['wordpress', /300〜600文字/, 20000],
  ];
  for (const [platform, guide, max] of cases) {
    const { fetchFn, calls } = makeFetch(200, apiResponse({
      caption: 'あ'.repeat(max + 50), hashtags: [],
    }));
    const { write } = createCaptionWriter({ apiKey: 'key', fetchFn });
    const { caption } = await write({ images: images(1), platform });

    assert.match(JSON.parse(calls[0].init.body).system, guide, platform);
    assert.equal(caption.length, max, `${platform} は ${max} 文字に収まる`);
  }
});

test('X はハッシュタグを落としてでも280文字に収める', async () => {
  const { fetchFn } = makeFetch(200, apiResponse({
    caption: 'あ'.repeat(270), hashtags: ['ここっとベール', '大阪トリミング'],
  }));
  const { write } = createCaptionWriter({ apiKey: 'key', fetchFn });
  const { caption } = await write({ images: images(1), platform: 'x' });
  assert.ok(caption.length <= 280, `280文字以内: ${caption.length}`);
  assert.ok(caption.startsWith('あ'.repeat(270)), '本文は削らない');
});
