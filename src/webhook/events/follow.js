// follow イベント: customers に line_user_id を upsert する。
// 再フォロー（ブロック解除）の場合は is_blocked を戻して配信対象に復帰させる。

export function createFollowHandler({ pool, lineClient }) {
  return async function handleFollow(event) {
    const lineUserId = event.source?.userId;
    if (!lineUserId) return;

    // 氏名は LIFF 登録（Phase 2）で確定させる。それまでは LINE の表示名を仮置きする
    let displayName = '未登録';
    try {
      const profile = await lineClient.getProfile(lineUserId);
      if (profile?.displayName) displayName = profile.displayName;
    } catch {
      // プロフィール非公開などで取れなくても登録は続行する
    }

    const { rows } = await pool.query(
      `INSERT INTO customers (line_user_id, name)
       VALUES ($1, $2)
       ON CONFLICT (line_user_id)
       DO UPDATE SET is_blocked = false, updated_at = now()
       RETURNING id`,
      [lineUserId, displayName]
    );
    console.log(`[follow] customer=${rows[0].id}`);

    // あいさつ（応答メッセージなので通数無料）。LIFF 導線は Phase 2 で追加する
    if (event.replyToken) {
      await lineClient.reply(
        event.replyToken,
        [
          {
            type: 'text',
            text: '友だち追加ありがとうございます！\nご予約のご案内をお届けするため、後日お送りするフォームより情報のご登録をお願いいたします。',
          },
        ],
        { customerId: rows[0].id }
      );
    }
  };
}
