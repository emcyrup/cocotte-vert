// 休眠フォローの Flex Message テンプレート。
// 営業色を抑え、末尾に配信停止導線を必ず入れる（spec 2-3）。

import { toParagraphs } from './paragraphs.js';

// 既定の本文。最終来店から日が経った方に送る。売り込みに読まれないよう、
// 予約を促す言葉は入れず、わんちゃんの近況を尋ねる形にとどめる
export const DEFAULT_BODY =
  'ご無沙汰しております。わんちゃんはお変わりありませんか？'
  + '\n毛のもつれや皮膚のことなど、気になることがあればいつでもお気軽にご相談ください。';

export function buildDormantMessage({ customerName, bodyText = DEFAULT_BODY }) {
  return {
    type: 'flex',
    altText: 'ご無沙汰しております',
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
            style: 'link',
            height: 'sm',
            action: {
              type: 'postback',
              label: '今後この案内が不要な方はこちら',
              data: 'action=opt_out',
              displayText: '案内の配信を停止する',
            },
          },
        ],
      },
    },
  };
}
