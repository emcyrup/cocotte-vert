// 公式LINE から送られた予約の下書き（reservation_drafts）の読み書き。
//
// 本予約の作成そのものは reservationService.createManual に任せる。上流が何であっても
// 予約は必ずあのアダプタを通す約束のため、ここでは下書きの管理だけを持つ。
//
// 下書きは「送られてきた場所」でも絞り込む。別のトークからボタンを押されても
// 他人の下書きを確定できないようにするため、取得・更新のすべてで場所を条件に入れる。

import { normalizePhone } from '../customers/phone.js';
import { stayLabel } from './stay.js';

// これより古い下書きは登録できない。読み違いに気付かないまま何日も経った
// ボタンを押されると、意図しない予約が入るため
const DRAFT_TTL_HOURS = 24;

// 同名の候補を出す上限。これを超えるほど曖昧なら、画面から入れてもらう
const MAX_CANDIDATES = 5;

const DRAFT_COLUMNS = `
  d.id, d.customer_id, d.new_customer_name, d.new_customer_phone,
  d.staff_id, d.menu, d.reserved_at, d.duration_minutes,
  -- DATE は pg がサーバーのタイムゾーンで Date に変換して1日ずれることがある。文字列で受け取る
  to_char(d.checkout_date, 'YYYY-MM-DD') AS checkout_date,
  d.raw_text, d.status::text AS status, d.reservation_id,
  d.created_at > now() - make_interval(hours => ${DRAFT_TTL_HOURS}) AS fresh`;

export function createReservationDrafts({ pool, reservationService }) {
  /**
   * 電話番号があればそれで、無ければ名前で顧客を探す。
   * 電話番号は突合キーなので、一致すればそれが本人。名前は同姓同名がありうるため候補として返す。
   */
  async function findCustomers({ name, phone }) {
    const phoneNorm = normalizePhone(phone);
    if (phoneNorm) {
      const { rows } = await pool.query(
        `SELECT id, name, phone_norm FROM customers WHERE phone_norm = $1`,
        [phoneNorm]
      );
      if (rows.length > 0) return { matches: rows, by: 'phone', phoneNorm };
    }

    // 姓名の間の空白は入れ方が揺れるため、両側から除いて比較する
    const { rows: exact } = await pool.query(
      `SELECT id, name, phone_norm FROM customers
       WHERE replace(replace(name, ' ', ''), '　', '')
           = replace(replace($1, ' ', ''), '　', '')
       ORDER BY id LIMIT $2`,
      [name, MAX_CANDIDATES + 1]
    );
    if (exact.length > 0) return { matches: exact, by: 'name', phoneNorm };

    // 「田中」で「田中花子」を引き当てられるようにする。完全一致が無いときだけ使う
    const { rows: partial } = await pool.query(
      `SELECT id, name, phone_norm FROM customers
       WHERE name ILIKE '%' || $1 || '%'
       ORDER BY id LIMIT $2`,
      [name, MAX_CANDIDATES + 1]
    );
    return { matches: partial, by: partial.length > 0 ? 'partial' : 'none', phoneNorm };
  }

  async function findStaffByName(name) {
    if (!name) return null;
    const { rows } = await pool.query(
      `SELECT id, name FROM staff
       WHERE active = true
         AND replace(replace(name, ' ', ''), '　', '')
           = replace(replace($1, ' ', ''), '　', '')`,
      [name]
    );
    // 同名が複数いるときは担当を決められない。未定のまま登録し、あとで画面から直してもらう
    return rows.length === 1 ? rows[0] : null;
  }

  /**
   * 解釈済みの内容を下書きとして保存する。
   * @param {{type: string, id: string}} p.source 送られてきた場所
   */
  async function create({ source, entry, customerId = null, newCustomer = null, staffId = null }) {
    const reservedAt = `${entry.date}T${entry.time}:00+09:00`;
    const { rows } = await pool.query(
      `INSERT INTO reservation_drafts
         (source_type, source_id, customer_id, new_customer_name, new_customer_phone,
          staff_id, menu, reserved_at, duration_minutes, checkout_date, raw_text)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        source.type, source.id, customerId,
        newCustomer?.name ?? null, newCustomer?.phone ?? null,
        staffId, entry.menu, reservedAt, entry.durationMinutes,
        entry.checkoutDate ?? null, entry.rawText,
      ]
    );
    return rows[0].id;
  }

  // BIGINT は pg が文字列で返す。予約の作成側は数値の id を求めるため、ここで揃えておく
  function toDraft(row) {
    if (!row) return null;
    const num = (v) => (v == null ? null : Number(v));
    return { ...row, customer_id: num(row.customer_id), staff_id: num(row.staff_id) };
  }

  /** 下書き1件。送られてきた場所が違えば見つからない扱いにする */
  async function get({ draftId, source }) {
    const { rows } = await pool.query(
      `SELECT ${DRAFT_COLUMNS},
              c.name AS customer_name, s.name AS staff_name
         FROM reservation_drafts d
         LEFT JOIN customers c ON c.id = d.customer_id
         LEFT JOIN staff s ON s.id = d.staff_id
        WHERE d.id = $1 AND d.source_type = $2 AND d.source_id = $3`,
      [draftId, source.type, source.id]
    );
    return toDraft(rows[0]);
  }

  /** 同名が複数いた場合に、どの方かを選んでもらった結果を反映する */
  async function pickCustomer({ draftId, source, customerId }) {
    const { rows } = await pool.query(
      `UPDATE reservation_drafts SET customer_id = $4
        WHERE id = $1 AND source_type = $2 AND source_id = $3 AND status = 'pending'
        RETURNING id`,
      [draftId, source.type, source.id, customerId]
    );
    if (rows.length === 0) return { ok: false, error: 'not_found' };
    return { ok: true, draft: await get({ draftId, source }) };
  }

  async function cancel({ draftId, source }) {
    const { rows } = await pool.query(
      `UPDATE reservation_drafts SET status = 'cancelled', decided_at = now()
        WHERE id = $1 AND source_type = $2 AND source_id = $3 AND status = 'pending'
        RETURNING id`,
      [draftId, source.type, source.id]
    );
    if (rows.length === 0) return { ok: false, error: 'not_found' };
    return { ok: true };
  }

  /** 名前だけの新規のお客様を作る。電話番号が既存と重なる場合はその方に寄せる */
  async function createCustomer({ name, phone }) {
    if (phone) {
      const { rows: existing } = await pool.query(
        `SELECT id FROM customers WHERE phone_norm = $1`,
        [phone]
      );
      if (existing.length > 0) return Number(existing[0].id);
    }
    const { rows } = await pool.query(
      `INSERT INTO customers (name, phone_norm) VALUES ($1, $2) RETURNING id`,
      [name, phone]
    );
    return Number(rows[0].id);
  }

  /**
   * 下書きを本予約にする。
   * 先に下書きを registered へ倒してから予約を作る（二重に押されても1件しか入らないように）。
   */
  async function register({ draftId, source }) {
    const draft = await get({ draftId, source });
    if (!draft) return { ok: false, error: 'not_found' };
    if (draft.status !== 'pending') return { ok: false, error: 'already_decided', draft };
    if (!draft.fresh) return { ok: false, error: 'expired', draft };
    if (!draft.customer_id && !draft.new_customer_name) {
      return { ok: false, error: 'customer_unresolved', draft };
    }

    const { rows: claimed } = await pool.query(
      `UPDATE reservation_drafts SET status = 'registered', decided_at = now()
        WHERE id = $1 AND source_type = $2 AND source_id = $3 AND status = 'pending'
        RETURNING id`,
      [draftId, source.type, source.id]
    );
    if (claimed.length === 0) return { ok: false, error: 'already_decided', draft };

    let customerId = draft.customer_id;
    let created = false;
    try {
      if (!customerId) {
        customerId = await createCustomer({
          name: draft.new_customer_name,
          phone: draft.new_customer_phone,
        });
        created = true;
        await pool.query(`UPDATE reservation_drafts SET customer_id = $2 WHERE id = $1`, [
          draftId, customerId,
        ]);
      }

      // 退室日は reservations に列を持たない。予約一覧で見えるようメモに残す
      const stay = stayLabel({
        reservedAt: draft.reserved_at,
        checkoutDate: draft.checkout_date,
      });
      const result = await reservationService.createManual({
        customerId,
        reservedAt: draft.reserved_at,
        menu: draft.menu,
        staffId: draft.staff_id,
        durationMinutes: draft.duration_minutes,
        note: stay ? `お泊まり ${stay}` : null,
      });
      if (!result.ok) throw new Error(`createManual: ${result.error}`);

      await pool.query(`UPDATE reservation_drafts SET reservation_id = $2 WHERE id = $1`, [
        draftId, result.reservationId,
      ]);
      return { ok: true, draft, customerId, createdCustomer: created, reservationId: result.reservationId };
    } catch (err) {
      // 予約が作れなかったのに下書きだけ決着済みになると、押し直しても入らなくなる
      await pool.query(
        `UPDATE reservation_drafts SET status = 'pending', decided_at = NULL WHERE id = $1`,
        [draftId]
      );
      throw err;
    }
  }

  // createCustomer は予約登録フォーム（LIFF）からも使う。電話番号の重なりを
  // 同じ扱いにしたいので、入口ごとに書かず1つを共有する
  return {
    findCustomers, findStaffByName, create, get, pickCustomer, cancel, register, createCustomer,
  };
}
