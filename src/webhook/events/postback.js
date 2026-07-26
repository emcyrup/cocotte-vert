// postback イベント: action で分岐する。
//   confirm — 前々日確認への返答（ok / change）
//   （followup / opt_out は Phase 4・5 で追加）
// 応答メッセージは通数無料のため、必ず reply で返す。

export function createPostbackHandler({ pool, lineClient, slack }) {
  async function handleConfirm(event, params) {
    const reservationId = Number(params.get('res'));
    const answer = params.get('v');
    const lineUserId = event.source?.userId;
    if (!Number.isInteger(reservationId) || !lineUserId) return;

    // 本人の予約であることを確認してから処理する（他人の予約 ID を投げられても無視）
    const { rows } = await pool.query(
      `SELECT r.id, r.reserved_at, r.customer_id, c.name AS customer_name, s.name AS staff_name
       FROM reservations r
       JOIN customers c ON c.id = r.customer_id
       LEFT JOIN staff s ON s.id = r.staff_id
       WHERE r.id = $1 AND c.line_user_id = $2`,
      [reservationId, lineUserId]
    );
    const reservation = rows[0];
    if (!reservation) {
      console.log(`[postback] confirm: 対象予約なし res=${reservationId}`);
      return;
    }

    if (answer === 'ok') {
      await pool.query(
        `UPDATE reservations SET confirmed_by_customer = true, updated_at = now() WHERE id = $1`,
        [reservationId]
      );
      await pool.query(
        `INSERT INTO customer_responses (customer_id, kind) VALUES ($1, $2)`,
        [reservation.customer_id, 'confirm_ok']
      );
      if (event.replyToken) {
        await lineClient.reply(
          event.replyToken,
          [{ type: 'text', text: 'ご確認ありがとうございます。お待ちしております！' }],
          { customerId: reservation.customer_id }
        );
      }
    } else if (answer === 'change') {
      await pool.query(
        `INSERT INTO customer_responses (customer_id, kind, notified_at) VALUES ($1, $2, now())`,
        [reservation.customer_id, 'confirm_change']
      );
      if (event.replyToken) {
        await lineClient.reply(
          event.replyToken,
          [
            {
              type: 'text',
              text: 'かしこまりました。担当者よりあらためてご連絡いたしますので、少々お待ちください。',
            },
          ],
          { customerId: reservation.customer_id }
        );
      }
      // 要対応としてスタッフへ即時通知（Slack への顧客名記載は spec 4. で定義済み）
      const when = reservation.reserved_at.toISOString();
      await slack.notify(
        `:rotating_light: *【要対応】予約変更希望*\n` +
          `顧客: ${reservation.customer_name}（customer=${reservation.customer_id}）\n` +
          `現予約: ${when}\n担当: ${reservation.staff_name ?? '未定'}\n` +
          `お客様へ連絡をお願いします。`
      );
    }
  }

  return async function handlePostback(event) {
    const params = new URLSearchParams(event.postback?.data ?? '');
    const action = params.get('action');
    if (action === 'confirm') {
      await handleConfirm(event, params);
    }
    // 未知の action は将来のフェーズ用。ログだけ残して無視する
    else if (action) {
      console.log(`[postback] 未対応 action=${action}`);
    }
  };
}
