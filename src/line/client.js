// LINE Messaging API への送信は必ずこのモジュールを経由する。
// 誤爆防止の砦は2つ:
//   1. SEND_MODE の3段階ガード（dry_run / test / live）
//   2. message_logs.dedupe_key の UNIQUE 制約（挿入成功時のみ送信）
import { messagingApi } from '@line/bot-sdk';

// テストから config / pool / api を差し替えられるようファクトリにしている
export function createLineClient({ config, pool, api }) {
  const client =
    api ||
    new messagingApi.MessagingApiClient({
      channelAccessToken: config.line.channelAccessToken,
    });

  /**
   * 配信ジョブからの Push 送信。
   * 先に message_logs へ INSERT し、dedupe_key が重複していたら送信しない。
   * 送信失敗時は status を failed に更新する（ログ→送信の順序を崩さない）。
   *
   * @param {object} p
   * @param {number} p.customerId      顧客の内部 ID（ログ出力にはこれだけを使う）
   * @param {string} p.lineUserId      送信先。test モードでは差し替えられる
   * @param {string} p.jobType         pre_reminder | after_visit | dormant | birthday
   * @param {string} p.dedupeKey       二重送信防止キー
   * @param {number} [p.reservationId]
   * @param {object[]} p.messages      LINE メッセージオブジェクトの配列
   * @returns {Promise<{status: 'dry_run'|'sent'|'skipped'|'failed', error?: string}>}
   */
  async function deliver({ customerId, lineUserId, jobType, dedupeKey, reservationId, messages }) {
    if (config.sendMode === 'dry_run') {
      // dry_run は DB にも書かない。本実行時に dedupe されてしまうため
      console.log(
        `[dry_run] job=${jobType} customer=${customerId} dedupe=${dedupeKey}\n` +
          JSON.stringify(messages, null, 2)
      );
      return { status: 'dry_run' };
    }

    const inserted = await pool.query(
      `INSERT INTO message_logs (dedupe_key, customer_id, reservation_id, job_type, status)
       VALUES ($1, $2, $3, $4, 'sent')
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING id`,
      [dedupeKey, customerId, reservationId ?? null, jobType]
    );
    if (inserted.rows.length === 0) {
      console.log(`[skip] job=${jobType} customer=${customerId} dedupe=${dedupeKey}（送信済み）`);
      return { status: 'skipped' };
    }
    const logId = inserted.rows[0].id;

    // test モードは対象者が誰であっても宛先を差し替える
    const to = config.sendMode === 'test' ? config.testLineUserId : lineUserId;

    try {
      await client.pushMessage({ to, messages });
      console.log(`[sent] job=${jobType} customer=${customerId} mode=${config.sendMode}`);
      return { status: 'sent', logId };
    } catch (err) {
      await pool.query(
        `UPDATE message_logs SET status = 'failed', error = $2 WHERE id = $1`,
        [logId, String(err.message || err)]
      );
      console.error(`[failed] job=${jobType} customer=${customerId}: ${err.message}`);
      return { status: 'failed', logId, error: String(err.message || err) };
    }
  }

  /**
   * 応答メッセージ（通数無料）。replyToken はイベント発生者にしか使えないため
   * test モードでも宛先差し替えは行わない。dry_run では API を呼ばない。
   */
  async function reply(replyToken, messages, { customerId } = {}) {
    if (config.sendMode === 'dry_run') {
      console.log(
        `[dry_run reply] customer=${customerId ?? 'unknown'}\n` + JSON.stringify(messages, null, 2)
      );
      return { status: 'dry_run' };
    }
    await client.replyMessage({ replyToken, messages });
    return { status: 'sent' };
  }

  /** プロフィール取得（読み取りのみ。全モードで実行可） */
  async function getProfile(lineUserId) {
    return client.getProfile(lineUserId);
  }

  return { deliver, reply, getProfile };
}
