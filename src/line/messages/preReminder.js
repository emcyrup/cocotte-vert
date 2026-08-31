// 前々日確認の Flex Message テンプレート。
import { formatJstDateTime } from '../../util/jst.js';
import { toParagraphs } from './paragraphs.js';

export const formatReservedAt = formatJstDateTime;

// 既定の本文。管理画面で書き換えられるが、宛名・予約の詳細・ボタンは構造として固定
export const DEFAULT_BODY = 'わんちゃんのご予約日が近づいてまいりましたので、ご連絡いたします。';

export function buildPreReminderMessage({
  customerName, reservedAt, menu, staffName, reservationId, bodyText = DEFAULT_BODY,
}) {
  const when = formatReservedAt(reservedAt);
  const detailRow = (label, value) => ({
    type: 'box',
    layout: 'baseline',
    contents: [
      { type: 'text', text: label, size: 'sm', color: '#888888', flex: 2 },
      { type: 'text', text: value, size: 'sm', wrap: true, flex: 5 },
    ],
  });

  const details = [detailRow('日時', when)];
  // 店舗のメニュー表記に合わせて「コース」と呼ぶ（画面・料金表と揃える）
  if (menu) details.push(detailRow('コース', menu));
  if (staffName) details.push(detailRow('担当', staffName));

  return {
    type: 'flex',
    altText: `ご予約確認: ${when}`,
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: `${customerName}様`, weight: 'bold', size: 'md' },
          ...toParagraphs(bodyText),
          { type: 'box', layout: 'vertical', spacing: 'sm', margin: 'md', contents: details },
          { type: 'text', text: 'ご都合はいかがでしょうか？', size: 'sm', margin: 'md' },
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
              label: 'このまま伺います',
              data: `action=confirm&res=${reservationId}&v=ok`,
              displayText: 'このまま伺います',
            },
          },
          {
            type: 'button',
            style: 'secondary',
            action: {
              type: 'postback',
              label: '日程を変更したい',
              data: `action=confirm&res=${reservationId}&v=change`,
              displayText: '日程を変更したい',
            },
          },
        ],
      },
    },
  };
}
