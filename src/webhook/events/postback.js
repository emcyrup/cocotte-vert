// postback イベント: action で分岐する。
//   confirm  — 前々日確認への返答（ok / change）
//   followup — 来店7日後フォローへの返答（good / concern）
//   （opt_out は Phase 5 で追加）
// 応答メッセージは通数無料のため、必ず reply で返す。

export function createPostbackHandler({ pool, lineClient, slack }) {
  // 本人の予約であることを確認してから処理する（他人の予約 ID を投げられても無視）
  async function findOwnReservation(reservationId, lineUserId) {
    const { rows } = await pool.query(
      `SELECT r.id, r.reserved_at, r.customer_id,
              c.name AS customer_name, c.last_visit_at, s.name AS staff_name
       FROM reservations r
       JOIN customers c ON c.id = r.customer_id
       LEFT JOIN staff s ON s.id = r.staff_id
       WHERE r.id = $1 AND c.line_user_id = $2`,
      [reservationId, lineUserId]
    );
    return rows[0] ?? null;
  }

  async function handleConfirm(event, params) {
    const reservationId = Number(params.get('res'));
    const answer = params.get('v');
    const lineUserId = event.source?.userId;
    if (!Number.isInteger(reservationId) || !lineUserId) return;

    const reservation = await findOwnReservation(reservationId, lineUserId);
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
      await slack.notify(
        `:rotating_light: *【要対応】予約変更希望*\n` +
          `顧客: ${reservation.customer_name}（customer=${reservation.customer_id}）\n` +
          `現予約: ${reservation.reserved_at.toISOString()}\n担当: ${reservation.staff_name ?? '未定'}\n` +
          `お客様へ連絡をお願いします。`
      );
    }
  }

  async function handleFollowup(event, params) {
    const reservationId = Number(params.get('res'));
    const answer = params.get('v');
    const lineUserId = event.source?.userId;
    if (!Number.isInteger(reservationId) || !lineUserId) return;

    const reservation = await findOwnReservation(reservationId, lineUserId);
    if (!reservation) {
      console.log(`[postback] followup: 対象予約なし res=${reservationId}`);
      return;
    }

    if (answer === 'good') {
      await pool.query(
        `INSERT INTO customer_responses (customer_id, kind) VALUES ($1, $2)`,
        [reservation.customer_id, 'good']
      );
      if (event.replyToken) {
        await lineClient.reply(
          event.replyToken,
          [
            {
              type: 'text',
              text: 'ありがとうございます！またのご来店をお待ちしております。',
            },
          ],
          { customerId: reservation.customer_id }
        );
      }
    } else if (answer === 'concern') {
      await pool.query(
        `INSERT INTO customer_responses (customer_id, kind, notified_at) VALUES ($1, $2, now())`,
        [reservation.customer_id, 'concern']
      );
      if (event.replyToken) {
        await lineClient.reply(
          event.replyToken,
          [
            {
              type: 'text',
              text: 'ご不便をおかけしております。詳しい状況をこのままメッセージでお知らせいただけますか？担当者より折り返しご連絡いたします。',
            },
          ],
          { customerId: reservation.customer_id }
        );
      }
      const lastVisit = reservation.last_visit_at ?? '不明';
      await slack.notify(
        `:warning: *フォロー回答: 気になることがある*\n` +
          `顧客: ${reservation.customer_name}（customer=${reservation.customer_id}）\n` +
          `前回来店日: ${lastVisit}\n詳細の返信が来たら追って通知します。`
      );
    }
  }

  return async function handlePostback(event) {
    const params = new URLSearchParams(event.postback?.data ?? '');
    const action = params.get('action');
    if (action === 'confirm') {
      await handleConfirm(event, params);
    } else if (action === 'followup') {
      await handleFollowup(event, params);
    }
    // 未知の action は将来のフェーズ用。ログだけ残して無視する
    else if (action) {
      console.log(`[postback] 未対応 action=${action}`);
    }
  };
}
