// 誕生日祝いの Flex Message テンプレート。
// クーポンは LINE 公式アカウントのクーポン機能で作成した URL を埋め込む（通数を消費しない）。

import { toParagraphs } from './paragraphs.js';

// 既定の本文。クーポンの案内文は BIRTHDAY_COUPON_URL の有無に連動するため固定のまま
export const DEFAULT_BODY =
  'お誕生日おめでとうございます🎉\nいつもご利用いただきありがとうございます。\n素敵な一年になりますように！';

export function buildBirthdayMessage({ customerName, couponUrl, bodyText = DEFAULT_BODY }) {
  const body = {
    type: 'box',
    layout: 'vertical',
    spacing: 'md',
    contents: [
      { type: 'text', text: `${customerName}様`, weight: 'bold', size: 'md' },
      ...toParagraphs(bodyText),
    ],
  };

  const contents = { type: 'bubble', body };

  if (couponUrl) {
    body.contents.push({
      type: 'text',
      text: 'ささやかですが、バースデークーポンをご用意しました。今月末までお使いいただけます。',
      size: 'sm',
      wrap: true,
      margin: 'md',
    });
    contents.footer = {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'button',
          style: 'primary',
          action: { type: 'uri', label: 'クーポンを見る', uri: couponUrl },
        },
      ],
    };
  }

  return {
    type: 'flex',
    altText: 'お誕生日おめでとうございます🎉',
    contents,
  };
}
