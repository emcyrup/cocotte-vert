// SNS 投稿キャプションの下書き生成（Claude）。
//
// 写真そのものを見せて書かせる。文章だけを生成する用途なので、分類器（classifyFollowup）と違って
// 失敗を握り潰さずそのまま投げる ── スタッフが画面で押した操作の結果なので、
// 黙って空文字が返るより「なぜ出せなかったか」を出したほうがよい。
//
// できあがるのはあくまで下書き。投稿するかどうかは必ずスタッフが画面で確認して決める。

const API_URL = 'https://api.anthropic.com/v1/messages';

// 写真は多くても4枚だけ見せる。全部送っても文章はほとんど変わらないのに、
// 画像1枚あたりのトークンが大きいため費用だけが増える
const MAX_IMAGES = 4;

// 各 SNS の本文上限。Instagram のほうが長い
const LIMITS = {
  instagram: { chars: 2200, guide: '120〜200文字程度', tags: '5〜10個' },
  threads: { chars: 500, guide: '60〜120文字程度', tags: '2〜4個' },
};

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    caption: { type: 'string' },
    hashtags: { type: 'array', items: { type: 'string' } },
  },
  required: ['caption', 'hashtags'],
  additionalProperties: false,
};

function systemPrompt({ storeName, platform }) {
  const limit = LIMITS[platform];
  return [
    `あなたは「${storeName}」（犬のトリミングサロン・ペットホテル）のSNS担当です。`,
    `お店が撮った写真から、${platform === 'threads' ? 'スレッズ' : 'Instagram'}の投稿文の下書きを日本語で書いてください。`,
    '',
    '# 書き方',
    `- 本文は${limit.guide}。飼い主様に語りかける、やわらかい口調で。`,
    '- 絵文字は多くても2〜3個まで。',
    `- ハッシュタグは${limit.tags}。日本語中心で、店名と地域名を必ず1つずつ入れる。#は付けずに単語だけ返す。`,
    '',
    '# 守ること',
    '- 写真から分かることだけを書く。犬種・名前・年齢・飼い主様のことは推測しない。',
    '- 料金、キャンペーン、予約の空き状況など、確認できない情報を書かない。',
    '- 写真に人が写っていても、その人について書かない。',
    '- 写真の内容がはっきりしないときは、無理に説明せず日常のひとこまとして短くまとめる。',
  ].join('\n');
}

export function createCaptionWriter({ apiKey, model = 'claude-opus-5', fetchFn = fetch }) {
  /**
   * @param {{images: {mediaType: string, data: string}[], platform?: 'instagram'|'threads',
   *          storeName?: string, hint?: string}} params
   * @returns {Promise<{caption: string}>}
   */
  async function write({ images, platform = 'instagram', storeName = '当店', hint = '' }) {
    if (!apiKey) throw new Error('no_api_key');
    if (!Array.isArray(images) || images.length === 0) throw new Error('no_images');
    const limit = LIMITS[platform];
    if (!limit) throw new Error('invalid_platform');

    // 枚数が多いときは等間隔で間引く。最初の数枚だけだと1日の様子が偏るため
    const step = Math.max(1, Math.ceil(images.length / MAX_IMAGES));
    const picked = images.filter((_, i) => i % step === 0).slice(0, MAX_IMAGES);

    const content = picked.map((img) => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.data },
    }));
    content.push({
      type: 'text',
      text: hint
        ? `この写真の投稿文をお願いします。スタッフからの補足: ${hint}`
        : 'この写真の投稿文をお願いします。',
    });

    const res = await fetchFn(API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        // 本文自体は短いが、思考ぶんの余白がないと途中で切れる
        max_tokens: 4096,
        system: systemPrompt({ storeName, platform }),
        messages: [{ role: 'user', content }],
        // 短い文章なので深く考えさせる必要はない。費用と待ち時間を抑える
        output_config: { effort: 'low', format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
      }),
      // 画像を送るぶん分類より時間がかかる
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      console.error(`[caption] API エラー: HTTP ${res.status}`);
      throw new Error('api_error');
    }
    const body = await res.json();
    // 安全側の判定で断られることがある。content を読む前に必ず見る
    if (body.stop_reason === 'refusal') throw new Error('refused');
    if (body.stop_reason === 'max_tokens') throw new Error('too_long');

    const raw = body.content?.find((b) => b.type === 'text')?.text;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('bad_response');
    }
    const caption = typeof parsed.caption === 'string' ? parsed.caption.trim() : '';
    if (!caption) throw new Error('bad_response');

    const tags = (Array.isArray(parsed.hashtags) ? parsed.hashtags : [])
      .filter((t) => typeof t === 'string' && t.trim())
      .map((t) => '#' + t.trim().replace(/^#+/, '').replace(/\s+/g, ''));

    return { caption: fit(caption, tags, limit.chars) };
  }

  return { write };
}

/**
 * 上限に収める。文字数の制約は構造化出力のスキーマでは表現できないため、ここで詰める。
 * 本文を削るより先にハッシュタグを落とす（本文が途中で切れるほうが読み手には不自然なため）。
 */
function fit(caption, tags, max) {
  const kept = [...tags];
  while (kept.length > 0 && `${caption}\n\n${kept.join(' ')}`.length > max) kept.pop();
  const text = kept.length ? `${caption}\n\n${kept.join(' ')}` : caption;
  return text.length > max ? text.slice(0, max) : text;
}
