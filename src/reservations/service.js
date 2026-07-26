// 予約書き込みのアダプタ層。上流（外部 SaaS / 管理画面の手入力）が何であっても
// 必ずここを経由して reservations に入れる。上流を差し替えてもここから下は作り直さない。
import { normalizePhone } from '../customers/phone.js';

export function createReservationService({ pool, slack }) {
  async function findOrCreateStaff(client, staffName) {
    if (!staffName) return null;
    const { rows } = await client.query(
      `SELECT id FROM staff WHERE name = $1 AND active = true`,
      [staffName]
    );
    if (rows.length > 0) return rows[0].id;
    const inserted = await client.query(
      `INSERT INTO staff (name) VALUES ($1) RETURNING id`,
      [staffName]
    );
    return inserted.rows[0].id;
  }

  async function notifyNewReservation({ customerName, reservedAt, menu, staffName }) {
    await slack.notify(
      `:calendar: *新規予約*\n顧客: ${customerName}\n日時: ${new Date(reservedAt).toISOString()}\n` +
        `メニュー: ${menu ?? '未設定'}\n担当: ${staffName ?? '未定'}`
    );
  }

  /** visited になった予約の来店日を customers.last_visit_at に反映する（後退はさせない） */
  async function touchLastVisit(client, customerId, reservedAt) {
    await client.query(
      `UPDATE customers
       SET last_visit_at = GREATEST(
             COALESCE(last_visit_at, '1970-01-01'::date),
             ($2::timestamptz AT TIME ZONE 'Asia/Tokyo')::date
           ),
           updated_at = now()
       WHERE id = $1`,
      [customerId, reservedAt]
    );
  }

  /**
   * 外部予約システムからの取り込み。external_id で冪等に upsert する。
   * 顧客は電話番号で突合し、いなければ新規作成（line_user_id には触らない）。
   */
  async function upsertExternal({
    externalId,
    customerName,
    phone,
    birthday,
    menu,
    staffName,
    reservedAt,
    status = 'confirmed',
  }) {
    if (!externalId) return { ok: false, error: 'external_id_required' };
    const phoneNorm = normalizePhone(phone);
    if (!phoneNorm) return { ok: false, error: 'invalid_phone' };
    if (!customerName?.trim()) return { ok: false, error: 'invalid_name' };
    if (!reservedAt || Number.isNaN(Date.parse(reservedAt))) {
      return { ok: false, error: 'invalid_reserved_at' };
    }

    const client = await pool.connect();
    let result;
    try {
      await client.query('BEGIN');

      const { rows: byPhone } = await client.query(
        `SELECT id, name FROM customers WHERE phone_norm = $1 FOR UPDATE`,
        [phoneNorm]
      );
      let customerId;
      if (byPhone.length > 0) {
        customerId = byPhone[0].id;
      } else {
        const inserted = await client.query(
          `INSERT INTO customers (name, phone_norm, birthday) VALUES ($1, $2, $3) RETURNING id`,
          [customerName.trim(), phoneNorm, birthday || null]
        );
        customerId = inserted.rows[0].id;
      }

      const staffId = await findOrCreateStaff(client, staffName);

      // xmax = 0 なら INSERT（新規）、そうでなければ UPDATE（更新）
      const { rows } = await client.query(
        `INSERT INTO reservations (customer_id, staff_id, menu, reserved_at, status, external_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (external_id) DO UPDATE
           SET customer_id = EXCLUDED.customer_id,
               staff_id = EXCLUDED.staff_id,
               menu = EXCLUDED.menu,
               reserved_at = EXCLUDED.reserved_at,
               status = EXCLUDED.status,
               updated_at = now()
         RETURNING id, (xmax = 0) AS inserted`,
        [customerId, staffId, menu || null, reservedAt, status, externalId]
      );

      if (status === 'visited') {
        await touchLastVisit(client, customerId, reservedAt);
      }
      await client.query('COMMIT');
      result = {
        ok: true,
        reservationId: rows[0].id,
        customerId,
        created: rows[0].inserted === true,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // 新規の確定予約のみ通知（更新のたびに鳴らさない）
    if (result.created && status === 'confirmed') {
      await notifyNewReservation({ customerName, reservedAt, menu, staffName });
    }
    return result;
  }

  /** 管理画面からの手入力予約 */
  async function createManual({ customerId, reservedAt, menu, staffId }) {
    if (!Number.isInteger(customerId)) return { ok: false, error: 'invalid_customer' };
    if (!reservedAt || Number.isNaN(Date.parse(reservedAt))) {
      return { ok: false, error: 'invalid_reserved_at' };
    }

    const { rows: customers } = await pool.query(`SELECT name FROM customers WHERE id = $1`, [
      customerId,
    ]);
    if (customers.length === 0) return { ok: false, error: 'customer_not_found' };

    const { rows } = await pool.query(
      `INSERT INTO reservations (customer_id, staff_id, menu, reserved_at)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [customerId, staffId || null, menu || null, reservedAt]
    );

    let staffName = null;
    if (staffId) {
      const { rows: staff } = await pool.query(`SELECT name FROM staff WHERE id = $1`, [staffId]);
      staffName = staff[0]?.name ?? null;
    }
    await notifyNewReservation({
      customerName: customers[0].name,
      reservedAt,
      menu,
      staffName,
    });
    return { ok: true, reservationId: rows[0].id };
  }

  /** 予約ステータスの更新。visited は last_visit_at にも反映する */
  async function setStatus(reservationId, status) {
    const allowed = ['confirmed', 'cancelled', 'visited', 'no_show'];
    if (!allowed.includes(status)) return { ok: false, error: 'invalid_status' };

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `UPDATE reservations SET status = $2, updated_at = now()
         WHERE id = $1
         RETURNING customer_id, reserved_at`,
        [reservationId, status]
      );
      if (rows.length === 0) {
        await client.query('ROLLBACK');
        return { ok: false, error: 'not_found' };
      }
      if (status === 'visited') {
        await touchLastVisit(client, rows[0].customer_id, rows[0].reserved_at);
      }
      await client.query('COMMIT');
      return { ok: true };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  return { upsertExternal, createManual, setStatus };
}
