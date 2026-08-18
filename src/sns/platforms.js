// 投稿先ごとの決まりごとを1か所にまとめる。
//
// 投稿先が増えるたびに publisher・ルーティング・画面へ if を足していくと、
// どこか1か所を直し忘れて「その投稿先だけ挙動が違う」が起きる。ここを唯一の出どころにして、
// 新しい投稿先は「この表に1行足してクライアントを1つ書く」だけで済むようにしている。

export const PLATFORMS = {
  instagram: {
    label: 'Instagram',
    // 1投稿に入る写真の上限。超えたぶんは split が true なら次の投稿へ回す
    maxPhotos: 10,
    split: true,
    maxCaption: 2200,
    // 写真なしで投稿できるか（Instagram は画像必須）
    photoRequired: true,
  },
  threads: {
    label: 'スレッズ',
    maxPhotos: 20,
    split: false,
    maxCaption: 500,
    photoRequired: true,
  },
  x: {
    label: 'X',
    // X は1投稿4枚まで。分割すると連投になり印象が悪いので、超過分は載せない
    maxPhotos: 4,
    split: false,
    maxCaption: 280,
    photoRequired: false,
  },
  wordpress: {
    label: 'WordPress',
    maxPhotos: 20,
    split: false,
    // 記事なので実質上限なし。それでも青天井にはしない
    maxCaption: 20000,
    photoRequired: false,
  },
};

export const PLATFORM_KEYS = Object.keys(PLATFORMS);

export const isPlatform = (key) => Object.hasOwn(PLATFORMS, key);

export const labelOf = (key) => PLATFORMS[key]?.label ?? key;

export const maxCaptionOf = (key) => PLATFORMS[key]?.maxCaption ?? 2200;

/**
 * 写真を投稿単位に割る。
 * split が false の投稿先は上限までで打ち切る（連投にしないため）。
 */
export function splitForPlatform(key, files, caption) {
  const spec = PLATFORMS[key] ?? PLATFORMS.instagram;
  if (!spec.split) {
    return [{ files: files.slice(0, spec.maxPhotos), caption }];
  }
  const chunks = [];
  for (let i = 0; i < files.length; i += spec.maxPhotos) {
    chunks.push(files.slice(i, i + spec.maxPhotos));
  }
  if (chunks.length === 0) chunks.push([]);
  return chunks.map((chunk, i) => ({
    files: chunk,
    caption:
      chunks.length === 1 || i === 0
        ? caption
        : `${caption}\n\nつづき（${i + 1}/${chunks.length}）`,
  }));
}
