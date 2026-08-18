// 「予約登録」と送られたときに返す、予約登録フォームへのボタン。
//
// 文章での登録はお名前の読み取りが当たらないことがあり、そのたびに送り直しになる。
// フォームなら探して選べるので、お客様の取り違えも送り直しも起きない。
// そのため、こちらを主な入口として案内する。

export function buildEntryFormMessage({ liffUrl, headline = '予約登録' }) {
  return {
    type: 'flex',
    altText: '予約登録はこちら',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: headline, weight: 'bold', size: 'lg' },
          {
            type: 'text',
            text: '下のボタンから、お客様を探して予約を入れられます。',
            size: 'sm',
            wrap: true,
          },
          {
            type: 'text',
            text: '飼い主様のお名前・お電話番号・わんちゃんのお名前、どれでも探せます。'
              + 'お泊まりの退室日も入れられます。',
            size: 'xs',
            color: '#888888',
            wrap: true,
            margin: 'md',
          },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'button',
            style: 'primary',
            action: { type: 'uri', label: '予約登録フォームを開く', uri: liffUrl },
          },
        ],
      },
    },
  };
}
