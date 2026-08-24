// EPARK など外部の予約サイトとの重複防止。
//
// 予約の入口はこのアプリを正とするが、EPARK からもお客様が予約できる状態が続く。
// こちらで予約が入ったら EPARK 側の同じ枠を閉じておかないと、別のお客様が入って
// ダブルブッキングになる。EPARK には外部から書き込む口が無いため、閉じるのは手作業。
//
// ここが持つのは「やった／まだ」だけ。**やり忘れを画面に出すこと**が目的で、
// 自動で何かを送るわけではない。
//
// 作業は2種類ある。取り消したのに枠を閉じたままだと、その時間の予約を取り逃がす。
//   閉じる   … このアプリで入った、これからの確定予約
//   開け直す … 枠を閉じたあとに取り消された予約

// 外部から取り込んだ予約（external_id あり）は、もともと EPARK 側にあるので対象外
const FROM_THIS_APP = 'r.external_id IS NULL';

// duration_minutes は「どこからどこまでの枠を閉じるか」に要る（自動化の駆動部が使う）。
// external_blocked_cells は「自分が実際に閉じた枠」。開け直すのはここだけに限る
const COLUMNS = `
  r.id, r.reserved_at, r.menu, r.status::text AS status, r.duration_minutes,
  r.external_blocked_cells,
  c.name AS customer_name, s.name AS staff_name`;

export function createExternalBlocks({ pool }) {
  /**
   * まだ手を付けていない作業。これからの予約だけを見る
   * （過ぎた予約の枠を今から閉じても意味がない）。
   */
  async function listPending() {
    const { rows } = await pool.query(
      `SELECT ${COLUMNS},
              CASE WHEN r.status = 'confirmed' THEN 'block' ELSE 'release' END AS action
         FROM reservations r
         JOIN customers c ON c.id = r.customer_id
         LEFT JOIN staff s ON s.id = r.staff_id
        WHERE ${FROM_THIS_APP}
          AND r.reserved_at > now()
          AND (
                (r.status = 'confirmed' AND r.external_blocked_at IS NULL)
             OR (r.status = 'cancelled' AND r.external_blocked_at IS NOT NULL)
              )
        ORDER BY r.reserved_at`
    );
    return {
      toBlock: rows.filter((r) => r.action === 'block'),
      toRelease: rows.filter((r) => r.action === 'release'),
    };
  }

  /**
   * 作業の済み・未済を記録する。
   * どちらの向きの作業かは**予約の状態から決める**（画面の申告は使わない。
   * 一覧を開いたあとに状態が変われば、押した時点の意味が変わるため）。
   */
  async function setDone({ id, done, cells = null }) {
    if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'invalid_id' };
    // 画面のチェックからは cells が来ない（手作業なのでどの枠を触ったか分からない）。
    // その場合は記録を消す。開け直すときは予約の時間から算出し、仮受付の印で守る
    const cellsJson = Array.isArray(cells) && cells.length > 0 ? JSON.stringify(cells) : null;

    const { rows } = await pool.query(
      `UPDATE reservations
          SET external_blocked_at = CASE
                -- 確定: 閉じたら記録、取り消したら未済へ戻す
                WHEN status = 'confirmed' THEN (CASE WHEN $2 THEN now() ELSE NULL END)
                -- 取消: 開け直したら記録を消す（もう閉じていないため）
                ELSE (CASE WHEN $2 THEN NULL ELSE now() END)
              END,
              -- 閉じたときだけ「自分が閉じた枠」を残す。開けたら消す
              external_blocked_cells = CASE
                WHEN status = 'confirmed' AND $2 THEN $3::jsonb
                ELSE NULL
              END,
              updated_at = now()
        WHERE id = $1 AND external_id IS NULL
        RETURNING id, status::text AS status`,
      [id, Boolean(done), cellsJson]
    );
    if (rows.length === 0) return { ok: false, error: 'not_found' };
    // 顧客は内部 id でのみ参照する（氏名はログに残さない）
    console.log(`[external-block] res=${id} done=${Boolean(done)}`);
    return { ok: true, reservation: rows[0] };
  }

  return { listPending, setDone };
}
