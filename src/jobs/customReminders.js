// 追加リマインドジョブ: スタッフが画面で定義したルール（custom_reminders）を配信する。
//
// 毎時の起床時に「その時刻のルール」だけを動かす。R1〜R4 と同じ守りをすべて通す:
// dedupe_key（同じ来店・予約に二度送らない）、SEND_MODE、opt_out、ブロック済み除外。
// スタッフが文面を書くため販促に寄りうるので、opt_out は種類を問わず除外する。
import { jstHour } from './runner.js';

// 文面に {お名前} と書くと飼い主様のお名前に置き換わる。凝った差し込みは増やさない
// （増やすほど、書き損じたときに壊れた文面がお客様へ届きやすくなる）
export function fillPlaceholders(message, { customerName }) {
  return message.replaceAll('{お名前}', `${customerName} 様`);
}

// ルールの条件ごとの対象者クエリ。日付は JST で確定させ、R1〜R4 と同じ書き方に揃える
const TARGET_SQL = {
  // 来店から days 日後（同じ日に複数回来店していたら最新の1件）
  after_visit: `
    SELECT DISTINCT ON (c.id)
           r.id, c.id AS customer_id, c.line_user_id, c.name AS customer_name
    FROM reservations r
    JOIN customers c ON c.id = r.customer_id
    WHERE r.status = 'visited'
      AND (r.reserved_at AT TIME ZONE 'Asia/Tokyo')::date
          = ((now() AT TIME ZONE 'Asia/Tokyo')::date - ($1 * INTERVAL '1 day'))::date
      AND c.line_user_id IS NOT NULL
      AND c.opt_out = false
      AND c.is_blocked = false
    ORDER BY c.id, r.reserved_at DESC`,
  // 予約の days 日前（確定した予約のみ）
  before_reservation: `
    SELECT r.id, c.id AS customer_id, c.line_user_id, c.name AS customer_name
    FROM reservations r
    JOIN customers c ON c.id = r.customer_id
    WHERE r.status = 'confirmed'
      AND (r.reserved_at AT TIME ZONE 'Asia/Tokyo')::date
          = ((now() AT TIME ZONE 'Asia/Tokyo')::date + ($1 * INTERVAL '1 day'))::date
      AND c.line_user_id IS NOT NULL
      AND c.opt_out = false
      AND c.is_blocked = false`,
};

export function createCustomRemindersJob({ pool, lineClient, hourOf = jstHour }) {
  return async function run() {
    const hour = hourOf();
    const { rows: rules } = await pool.query(
      `SELECT id, name, trigger_type, days, message FROM custom_reminders
       WHERE enabled = true AND send_hour = $1 ORDER BY id`,
      [hour]
    );

    const summary = { total: 0, sent: 0, dryRun: 0, skipped: 0, failed: 0, errors: [] };

    for (const rule of rules) {
      let targets;
      try {
        ({ rows: targets } = await pool.query(TARGET_SQL[rule.trigger_type], [rule.days]));
      } catch (err) {
        // ルール1つの失敗で他のルールを止めない（対象者1人の失敗と同じ扱い）
        summary.failed++;
        summary.errors.push({ customerId: `rule=${rule.id}`, message: err.message });
        continue;
      }
      summary.total += targets.length;

      for (const row of targets) {
        try {
          const result = await lineClient.deliver({
            customerId: row.customer_id,
            lineUserId: row.line_user_id,
            jobType: 'custom',
            // 同じルール×同じ来店（予約）には一度だけ。ルールを直しても再送しない
            dedupeKey: `custom:${rule.id}:res:${row.id}`,
            reservationId: row.id,
            messages: [
              { type: 'text', text: fillPlaceholders(rule.message, { customerName: row.customer_name }) },
            ],
          });
          if (result.status === 'sent') summary.sent++;
          else if (result.status === 'dry_run') summary.dryRun++;
          else if (result.status === 'skipped') summary.skipped++;
          else {
            summary.failed++;
            summary.errors.push({ customerId: row.customer_id, message: result.error ?? 'unknown' });
          }
        } catch (err) {
          summary.failed++;
          summary.errors.push({ customerId: row.customer_id, message: err.message });
        }
      }
    }
    return summary;
  };
}
