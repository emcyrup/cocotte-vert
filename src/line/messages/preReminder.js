// 前々日確認の Flex Message テンプレート。

// TZ 設定に依存せず必ず JST で整形する（テスト環境が UTC でも壊れないように）
const jstParts = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  month: 'numeric',
  day: 'numeric',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function formatReservedAt(date) {
  const parts = Object.fromEntries(jstParts.formatToParts(date).map((p) => [p.type, p.value]));
  return `${parts.month}月${parts.day}日(${parts.weekday}) ${parts.hour}:${parts.minute}`;
}

export function buildPreReminderMessage({ customerName, reservedAt, menu, staffName, reservationId }) {
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
  if (menu) details.push(detailRow('メニュー', menu));
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
          {
            type: 'text',
            text: 'ご予約日が近づいてまいりましたのでご連絡いたします。',
            size: 'sm',
            wrap: true,
          },
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
