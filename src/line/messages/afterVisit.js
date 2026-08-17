// 来店7日後フォローの Flex Message テンプレート。
//
// 宛先は飼い主様だが、聞きたいのは「わんちゃんの様子」。主語を人にすると
// 飼い主様ご本人の体調を尋ねているように読めるため、わんちゃんの話だと分かる書き方にする。
// わんちゃんの名前は入れない（同じお宅で複数頭いる場合に取り違えるため）。

export function buildAfterVisitMessage({ customerName, reservationId }) {
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
          {
            type: 'text',
            text: '先日はご来店いただきありがとうございました。\nその後、わんちゃんのご様子はいかがでしょうか？',
            size: 'sm',
            wrap: true,
          },
          {
            type: 'text',
            text: '皮膚のかゆみ、カットの仕上がりなど、気になることがあればこのままメッセージでお知らせください。',
            size: 'sm',
            wrap: true,
            margin: 'md',
          },
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
