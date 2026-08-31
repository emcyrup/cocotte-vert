// 来店7日後フォローの Flex Message テンプレート。
//
// 宛先は飼い主様だが、聞きたいのは「わんちゃんの様子」。主語を人にすると
// 飼い主様ご本人の体調を尋ねているように読めるため、わんちゃんの話だと分かる書き方にする。
// わんちゃんの名前は入れない（同じお宅で複数頭いる場合に取り違えるため）。

import { toParagraphs } from './paragraphs.js';

// 既定の本文（空行で段落を分ける）。管理画面で書き換えられる
export const DEFAULT_BODY =
  '先日はご来店いただきありがとうございました。\nその後、わんちゃんのご様子はいかがでしょうか？'
  + '\n\n皮膚のかゆみ、カットの仕上がりなど、気になることがあればこのままメッセージでお知らせください。';

export function buildAfterVisitMessage({ customerName, reservationId, bodyText = DEFAULT_BODY }) {
  return {
    type: 'flex',
    altText: 'ご来店ありがとうございました',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: `${customerName}様`, weight: 'bold', size: 'md' },
          ...toParagraphs(bodyText),
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'primary',
            action: {
              type: 'postback',
              label: '元気にしています',
              data: `action=followup&res=${reservationId}&v=good`,
              displayText: '元気にしています',
            },
          },
          {
            type: 'button',
            style: 'secondary',
            action: {
              type: 'postback',
              label: '気になることがある',
              data: `action=followup&res=${reservationId}&v=concern`,
              displayText: '気になることがある',
            },
          },
        ],
      },
    },
  };
}
