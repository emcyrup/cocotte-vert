// シフト変更申請（公式LINE からの自由記述 → 承認 → 本人へ通知）と、
// スタッフの LINE 連携。
//
// 日付・時刻は DB から文字列で取り出す（to_char）。Date へ変換すると UTC 基準になり、
// JST の日付が1日ずれるため。

import { randomInt } from 'node:crypto';
import { SETTING_KEYS } from '../settings.js';

const KIND_LABELS = {
  work: '出勤',
  am: 'AM半休',
  pm: 'PM半休',
  koukyu: '公休',
  yukyu: '有休',
  jikan: '時間休',
};

const LINK_CODE_TTL_HOURS = 24;

// スタッフ名の長さの上限。表やシフト表の列が崩れない範囲に収める
const MAX_STAFF_NAME = 30;

const weekdayFmt = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', weekday: 'short' });

/** 「8/1(土) 有休」「7/31(金) 時間休 10:00〜12:00」の形に整える */
export function formatShift(r) {
  const [, month, day] = r.target_date.split('-');
  const weekday = weekdayFmt.format(new Date(`${r.target_date}T00:00:00+09:00`));
  const label = KIND_LABELS[r.kind] ?? r.kind;
  const time = r.kind === 'jikan' && r.start_time ? ` ${r.start_time}〜${r.end_time}` : '';
  return `${Number(month)}/${Number(day)}(${weekday}) ${label}${time}`;
}

// 一覧・通知で共通して使う列。日付と時刻は必ず文字列で返す
const REQUEST_COLUMNS = `
  r.id, r.staff_id, s.name AS staff_name,
  to_char(r.target_date, 'YYYY-MM-DD') AS target_date,
  r.kind::text AS kind,
  to_char(r.start_time, 'HH24:MI') AS start_time,
  to_char(r.end_time, 'HH24:MI') AS end_time,
  r.reason, r.raw_text, r.status::text AS status, r.decided_at, r.created_at`;

export function createShiftService({ pool, lineClient, slack, settings = null, config = null }) {
  // ---- スタッフの LINE 連携 ----

  /** 管理画面から連携コードを発行する。既存のコードは上書きして使い捨てにする */
  async function issueLinkCode(staffId) {
    const code = String(randomInt(100000, 1000000));
    const { rows } = await pool.query(
      `UPDATE staff
       SET link_code = $2, link_code_expires_at = now() + make_interval(hours => $3)
       WHERE id = $1
       RETURNING id, name`,
      [staffId, code, LINK_CODE_TTL_HOURS]
    );
    if (rows.length === 0) return { ok: false, error: 'not_found' };
    return { ok: true, code, staff: rows[0], expiresInHours: LINK_CODE_TTL_HOURS };
  }

  /** スタッフが送ってきた合言葉で紐付ける。連携済みの LINE アカウントは付け替えない */
  async function linkStaffByCode({ lineUserId, code }) {
    const { rows } = await pool.query(
      `UPDATE staff
       SET line_user_id = $1, link_code = NULL, link_code_expires_at = NULL
       WHERE link_code = $2 AND link_code_expires_at > now()
         AND NOT EXISTS (SELECT 1 FROM staff o WHERE o.line_user_id = $1 AND o.id <> staff.id)
       RETURNING id, name`,
      [lineUserId, code]
    );
    if (rows.length === 0) return { ok: false, error: 'invalid_code' };
    return { ok: true, staff: rows[0] };
  }

  /**
   * スタッフグループでの「スタッフ登録 高橋」による紐付け。
   * 同姓のスタッフがいると誤って別人に紐づくため、1人に絞れないときは紐付けない。
   */
  async function linkStaffByName({ lineUserId, name }) {
    // 姓名の間の空白は入れ方が揺れるため、両側から除いて比較する
    const { rows: matches } = await pool.query(
      `SELECT id, name FROM staff
       WHERE active = true
         AND replace(replace(name, ' ', ''), '　', '') = replace(replace($1, ' ', ''), '　', '')`,
      [name]
    );
    if (matches.length === 0) return { ok: false, error: 'not_found' };
    if (matches.length > 1) return { ok: false, error: 'ambiguous' };

    const { rows } = await pool.query(
      `UPDATE staff SET line_user_id = $1, link_code = NULL, link_code_expires_at = NULL
       WHERE id = $2
         AND NOT EXISTS (SELECT 1 FROM staff o WHERE o.line_user_id = $1 AND o.id <> $2)
       RETURNING id, name`,
      [lineUserId, matches[0].id]
    );
    if (rows.length === 0) return { ok: false, error: 'already_linked_to_other' };
    return { ok: true, staff: rows[0] };
  }

  /** 名前が一致する在職スタッフ。姓名の間の空白は入れ方が揺れるため、除いて比べる */
  async function listActiveStaffByName(name) {
    const { rows } = await pool.query(
      `SELECT id, name, (line_user_id IS NOT NULL) AS linked
         FROM staff
        WHERE active = true
          AND replace(replace(name, ' ', ''), '　', '')
            = replace(replace($1, ' ', ''), '　', '')
        ORDER BY id`,
      [name]
    );
    return rows;
  }

  /**
   * スタッフ登録画面で入力された名前で紐付ける。
   *
   * 名簿に無ければ新しいスタッフとして作る（店長が先に登録しておかなくても始められる）。
   * 同姓が複数いるときは決めようがないため、候補を返して本人に選んでもらう。
   */
  async function linkStaffByTypedName({ lineUserId, name }) {
    const clean = String(name ?? '').replace(/[\s　]+/g, ' ').trim();
    if (!clean || clean.length > MAX_STAFF_NAME) return { ok: false, error: 'invalid_name' };

    // この LINE が今どのスタッフのものか。同姓の判断にも使う
    const mine = await findStaffByLineUserId(lineUserId);

    const matches = await listActiveStaffByName(clean);
    if (matches.length > 1) return { ok: false, error: 'ambiguous', candidates: matches };
    if (matches.length === 1) {
      const only = matches[0];
      // 同じ名前の人が既に別の LINE で登録済み。黙って上書きすると先に登録した人の
      // 連携が消えるため、区別の付く名前を入れ直してもらう
      if (only.linked && String(mine?.id ?? '') !== String(only.id)) {
        return { ok: false, error: 'name_taken', staff: { name: only.name } };
      }
      return linkStaffById({ lineUserId, staffId: only.id });
    }

    // 名簿に無いので新しく作る。作る前に、この LINE が既に別のスタッフのものでないかを見る
    // （先に作ってから弾くと、誰も使わないスタッフが名簿に残るため）
    if (mine) return { ok: false, error: 'already_linked_to_other', staff: mine };

    // 退職者と同じ名前でも止めない。前任者と姓が同じだけの別人、ということがあるため
    // （在職者に同じ名前がいる場合だけ、上の name_taken で入れ直してもらう）
    const { rows } = await pool.query(
      `INSERT INTO staff (name, line_user_id) VALUES ($1, $2) RETURNING id, name`,
      [clean, lineUserId]
    );
    return { ok: true, staff: rows[0], created: true };
  }

  /**
   * 一覧から選ばれたスタッフに紐付ける。名前ではなく id で指定するため曖昧さがない。
   * 連携済みの LINE アカウントは別のスタッフへ付け替えない（linkStaffByCode と同じ守り）。
   */
  async function linkStaffById({ lineUserId, staffId }) {
    const { rows } = await pool.query(
      `UPDATE staff SET line_user_id = $1, link_code = NULL, link_code_expires_at = NULL
       WHERE id = $2 AND active = true
         -- 既に別の人の LINE が入っているスタッフは奪えない（先に登録した人の連携が消えるため）
         AND (line_user_id IS NULL OR line_user_id = $1)
         -- この LINE が別のスタッフのものになっていないこと
         AND NOT EXISTS (SELECT 1 FROM staff o WHERE o.line_user_id = $1 AND o.id <> $2)
       RETURNING id, name`,
      [lineUserId, staffId]
    );
    if (rows.length > 0) return { ok: true, staff: rows[0] };

    // 更新できなかった理由を分けて返す。画面の案内文が変わるため
    const { rows: target } = await pool.query(
      `SELECT line_user_id FROM staff WHERE id = $1 AND active = true`,
      [staffId]
    );
    if (target.length === 0) return { ok: false, error: 'not_found' };
    if (target[0].line_user_id && target[0].line_user_id !== lineUserId) {
      return { ok: false, error: 'staff_taken' };
    }
    return { ok: false, error: 'already_linked_to_other' };
  }

  /**
   * 連携済みスタッフがスタッフグループに参加しているかを一覧で返す。
   * グループ未設定のときは判定そのものができないため、その旨だけを返す。
   */
  async function listStaffLineStatus() {
    const groupId =
      (settings ? await settings.get(SETTING_KEYS.staffLineGroupId).catch(() => null) : null) ??
      config?.staffLineGroupId ??
      null;
    if (!groupId) return { groupConfigured: false, membership: {} };

    const { rows } = await pool.query(
      `SELECT id, line_user_id FROM staff WHERE active = true AND line_user_id IS NOT NULL ORDER BY id`
    );
    const membership = {};
    // LINE のレート制限に配慮し、少人数前提で直列に確認する
    for (const s of rows) {
      membership[s.id] = await lineClient.getGroupMembership(groupId, s.line_user_id);
    }
    return { groupConfigured: true, membership };
  }

  async function findStaffByLineUserId(lineUserId) {
    const { rows } = await pool.query(
      `SELECT id, name FROM staff WHERE line_user_id = $1 AND active = true`,
      [lineUserId]
    );
    return rows[0] ?? null;
  }

  // ---- 申請 ----

  /**
   * 解釈済みの申請を保存する。
   * 同じ日について未決着（返事待ち・保留）が残っていると、どちらを採るか判断できないため、
   * 新しい申請で置き換える（確定・却下済みの履歴には手を付けない）。
   */
  async function createRequests({ staffId, entries, rawText }) {
    const created = [];
    let replaced = 0;
    for (const e of entries) {
      const { rowCount } = await pool.query(
        `DELETE FROM shift_requests
         WHERE staff_id = $1 AND target_date = $2 AND status IN ('pending', 'held')`,
        [staffId, e.date]
      );
      replaced += rowCount;
      const { rows } = await pool.query(
        `INSERT INTO shift_requests
           (staff_id, target_date, kind, start_time, end_time, reason, raw_text)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, to_char(target_date, 'YYYY-MM-DD') AS target_date,
                   kind::text AS kind,
                   to_char(start_time, 'HH24:MI') AS start_time,
                   to_char(end_time, 'HH24:MI') AS end_time`,
        [staffId, e.date, e.kind, e.startTime, e.endTime, e.reason, rawText]
      );
      created.push(rows[0]);
    }
    return { created, replaced };
  }

  async function listRequests({ status = null } = {}) {
    const { rows } = await pool.query(
      `SELECT ${REQUEST_COLUMNS}
       FROM shift_requests r
       JOIN staff s ON s.id = r.staff_id
       WHERE ($1::text IS NULL OR r.status::text = $1)
       ORDER BY (r.status IN ('pending', 'held')) DESC, r.target_date, r.id
       LIMIT 200`,
      [status]
    );
    return rows;
  }

  // ---- 週次シフト ----

  /**
   * 1マス分の登録・更新。kind が null なら未入力に戻す（行を消す）。
   * @param {string} p.date YYYY-MM-DD（JST の日付）
   */
  async function upsertShift({ staffId, date, kind, startTime = null, endTime = null }) {
    if (!kind) {
      await pool.query(`DELETE FROM shifts WHERE staff_id = $1 AND work_date = $2`, [staffId, date]);
      return { ok: true, shift: null };
    }
    // 時間休以外に時刻が残ると表示が崩れるため、ここで落とす
    const jikan = kind === 'jikan';
    const { rows } = await pool.query(
      `INSERT INTO shifts (staff_id, work_date, kind, start_time, end_time)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (staff_id, work_date) DO UPDATE
         SET kind = EXCLUDED.kind, start_time = EXCLUDED.start_time,
             end_time = EXCLUDED.end_time, updated_at = now()
       RETURNING id, to_char(work_date, 'YYYY-MM-DD') AS work_date, kind::text AS kind,
                 to_char(start_time, 'HH24:MI') AS start_time,
                 to_char(end_time, 'HH24:MI') AS end_time`,
      [staffId, date, kind, jikan ? startTime : null, jikan ? endTime : null]
    );
    return { ok: true, shift: rows[0] };
  }

  /**
   * 期間内のシフトを、スタッフ一覧とあわせて返す。
   * スタッフを追加すれば、その人の行が自動で増える（シフトが未入力でも一覧には出す）。
   */
  async function listShifts({ from, to }) {
    const { rows: staff } = await pool.query(
      `SELECT id, name FROM staff WHERE active = true ORDER BY id`
    );
    const { rows: shifts } = await pool.query(
      `SELECT staff_id, to_char(work_date, 'YYYY-MM-DD') AS work_date, kind::text AS kind,
              to_char(start_time, 'HH24:MI') AS start_time, to_char(end_time, 'HH24:MI') AS end_time
       FROM shifts
       WHERE work_date BETWEEN $1::date AND $2::date`,
      [from, to]
    );
    return { staff, shifts };
  }

  /**
   * 承認・却下。結果は必ず申請したスタッフへ LINE で伝える。
   * 通知に失敗しても判断自体は確定させ、Slack でスタッフに知らせる
   * （握り潰すと「承認したのに本人が知らない」状態になるため）。
   *
   * 本人が「保留」と答えた held も店長の判断対象。決着済み（approved / rejected）は動かさない。
   */
  async function decide({ id, status }) {
    if (!['approved', 'rejected'].includes(status)) return { ok: false, error: 'invalid_status' };

    const { rows } = await pool.query(
      `UPDATE shift_requests SET status = $2, decided_at = now()
       WHERE id = $1 AND status IN ('pending', 'held')
       RETURNING id`,
      [id, status]
    );
    if (rows.length === 0) return { ok: false, error: 'not_found' };

    const { rows: full } = await pool.query(
      `SELECT ${REQUEST_COLUMNS}, s.line_user_id
       FROM shift_requests r JOIN staff s ON s.id = r.staff_id
       WHERE r.id = $1`,
      [id]
    );
    const request = full[0];

    // 承認したら週次シフトへ反映する。ここを飛ばすと「承認したのに表が変わらない」ことになる
    if (status === 'approved') {
      await upsertShift({
        staffId: request.staff_id,
        date: request.target_date,
        kind: request.kind,
        startTime: request.start_time,
        endTime: request.end_time,
      });
    }

    const label = formatShift(request);
    const text =
      status === 'approved'
        ? `シフト変更が承認されました。\n${label}\nシフト表に反映しました。`
        : `シフト変更は見送りとなりました。\n${label}\nお手数ですが、店長へご相談ください。`;

    // 送れなかった理由（未連携／dry_run／失敗）を画面で区別できるようにする
    let delivery = request.line_user_id ? 'failed' : 'not_linked';
    if (request.line_user_id) {
      try {
        delivery = (await lineClient.pushStaff(request.line_user_id, text)).status;
      } catch (err) {
        await slack.notifyError(`シフト申請の結果通知に失敗（staff=${request.staff_id}）`, err);
      }
    }
    // line_user_id は返さない（画面・ログに出す必要がない）
    delete request.line_user_id;
    return { ok: true, request, notified: delivery === 'sent', delivery };
  }


  // ---- 本人がチャットで確定・保留する ----
  //
  // 店長の承認を挟まず、申請した本人の「確定」でシフト表へ反映する運用。
  // 取り違えを防ぐため、更新できるのは **その本人の pending の申請だけ** に絞る
  // （staff_id を条件に入れる。id だけで更新すると他人の申請を動かせてしまう）。

  /** 本人の返事待ちになっている申請を、新しい順に返す */
  async function listPendingForStaff(staffId) {
    const { rows } = await pool.query(
      `SELECT ${REQUEST_COLUMNS}
       FROM shift_requests r JOIN staff s ON s.id = r.staff_id
       WHERE r.staff_id = $1 AND r.status = 'pending'
       ORDER BY r.target_date, r.id`,
      [staffId]
    );
    return rows;
  }

  /**
   * 本人の返事を反映する。
   * @param {'confirm'|'hold'|'cancel'} answer
   */
  async function answerOwnRequests({ staffId, answer }) {
    const pending = await listPendingForStaff(staffId);
    if (pending.length === 0) return { ok: false, error: 'no_pending' };

    const status = { confirm: 'approved', hold: 'held', cancel: 'rejected' }[answer];
    if (!status) return { ok: false, error: 'invalid_answer' };

    const ids = pending.map((r) => r.id);
    const { rows } = await pool.query(
      `UPDATE shift_requests SET status = $3, decided_at = now()
       WHERE id = ANY($1::bigint[]) AND staff_id = $2 AND status = 'pending'
       RETURNING id`,
      [ids, staffId, status]
    );
    // 別経路（店長の画面操作など）で先に決まっていた場合は、取れた分だけを反映する
    const decided = pending.filter((r) => rows.some((x) => String(x.id) === String(r.id)));
    if (decided.length === 0) return { ok: false, error: 'no_pending' };

    if (status === 'approved') {
      for (const r of decided) {
        await upsertShift({
          staffId,
          date: r.target_date,
          kind: r.kind,
          startTime: r.start_time,
          endTime: r.end_time,
        });
      }
    }
    return { ok: true, status, requests: decided };
  }

  return {
    issueLinkCode,
    linkStaffByCode,
    linkStaffByName,
    listActiveStaffByName,
    linkStaffByTypedName,
    linkStaffById,
    listStaffLineStatus,
    upsertShift,
    listShifts,
    findStaffByLineUserId,
    createRequests,
    listRequests,
    decide,
    listPendingForStaff,
    answerOwnRequests,
  };
}
