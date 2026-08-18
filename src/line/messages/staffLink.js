// スタッフ用グループに置く「スタッフ登録」のボタン。
//
// グループのノート（アナウンス）に固定して使う想定なので、いつ見ても意味が通る文面にする。
// 押すと LIFF のスタッフ登録画面が開き、本人が自分の名前を選んで連携する。
//
// ボタンを押しただけでは連携されない。画面側で
//   ① LINE の ID トークンを検証して本人の userId を得る
//   ② その人がスタッフ用グループにいることを確かめる
// の2つを通ってから、選ばれた名前に紐付ける。

export function buildStaffLinkMessage({ liffUrl }) {
  return {
    type: 'flex',
    altText: 'スタッフ登録はこちら',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: 'スタッフ登録', weight: 'bold', size: 'lg' },
          {
            type: 'text',
            text: 'シフトの申請や、LINEからの予約登録を使う方は、下のボタンから登録してください。',
            size: 'sm',
            wrap: true,
          },
          {
            type: 'text',
            text: '開いた画面で自分の名前を選ぶだけです。1回だけの操作で、あとはこのトークからそのまま使えます。',
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
            action: { type: 'uri', label: 'スタッフ登録をはじめる', uri: liffUrl },
          },
        ],
      },
    },
  };
}

/** LIFF が未設定の環境では、これまでどおりの登録方法を案内する */
export const staffLinkFallbackText =
  'スタッフ登録の画面がまだ使えません（LIFF 未設定）。\n' +
  'お手数ですが、これまでどおりの方法で登録してください。\n' +
  '・このグループで「スタッフ登録 高橋」のようにお名前を送る\n' +
  '・または、店長が発行した6桁のコードを送る';
