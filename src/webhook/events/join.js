// join イベント: Bot がグループに招待されたときにグループ ID を返信する。
// スタッフ通知用グループの ID を .env に設定する作業を楽にするための導線。

export function createJoinHandler({ lineClient }) {
  return async function handleJoin(event) {
    if (event.source?.type !== 'group') return;
    const groupId = event.source.groupId;
    console.log(`[join] グループに参加しました`);

    if (event.replyToken) {
      await lineClient.reply(event.replyToken, [
        {
          type: 'text',
          text:
            'グループに追加ありがとうございます。\n' +
            'このグループをスタッフ通知先にする場合は、以下の ID をサーバーの .env（STAFF_LINE_GROUP_ID）に設定してください。\n\n' +
            groupId,
        },
      ]);
    }
  };
}
