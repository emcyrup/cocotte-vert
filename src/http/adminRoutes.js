// 管理画面用 API。全ルートが Basic 認証（index.js 側で適用）配下にある前提。
import express from 'express';
import { normalizePhone } from '../customers/phone.js';

export function createAdminRouter({ pool, reservationService }) {
  const router = express.Router();

  // ---- スタッフ ----
  router.get('/staff', async (_req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, name FROM staff WHERE active = true ORDER BY id`
      );
      res.json({ staff: rows });
    } catch (err) {
      next(err);
    }
  });

  router.post('/staff', async (req, res, next) => {
    try {
      const name = req.body?.name?.trim();
      if (!name) return res.status(400).json({ error: 'invalid_name' });
      const { rows } = await pool.query(
        `INSERT INTO staff (name) VALUES ($1) RETURNING id, name`,
        [name]
      );
      res.json({ ok: true, staff: rows[0] });
    } catch (err) {
      next(err);
    }
  });

  // ---- 顧客 ----
  router.get('/customers', async (req, res, next) => {
    try {
      const q = (req.query.q ?? '').trim();
      const phoneNorm = normalizePhone(q);
      const { rows } = await pool.query(
        `SELECT id, name, phone_norm, birthday, last_visit_at, opt_out, is_blocked,
                (line_user_id IS NOT NULL) AS line_linked
         FROM customers
         WHERE ($1 = '' OR name ILIKE '%' || $1 || '%' OR ($2::text IS NOT NULL AND phone_norm LIKE $2 || '%'))
         ORDER BY id DESC
         LIMIT 30`,
        [q, phoneNorm]
      );
      res.json({ customers: rows });
    } catch (err) {
      next(err);
    }
  });

  router.post('/customers', async (req, res, next) => {
    try {
      const { name, phone, birthday } = req.body ?? {};
      if (!name?.trim()) return res.status(400).json({ error: 'invalid_name' });
      const phoneNorm = normalizePhone(phone);
      if (!phoneNorm) return res.status(400).json({ error: 'invalid_phone' });
      if (birthday && !/^\d{4}-\d{2}-\d{2}$/.test(birthday)) {
        return res.status(400).json({ error: 'invalid_birthday' });
      }
      const { rows: existing } = await pool.query(
        `SELECT id FROM customers WHERE phone_norm = $1`,
        [phoneNorm]
      );
      if (existing.length > 0) {
        return res.status(409).json({ error: 'phone_exists', customerId: existing[0].id });
      }
      const { rows } = await pool.query(
        `INSERT INTO customers (name, phone_norm, birthday) VALUES ($1, $2, $3) RETURNING id`,
        [name.trim(), phoneNorm, birthday || null]
      );
      res.json({ ok: true, customerId: rows[0].id });
    } catch (err) {
      next(err);
    }
  });

  // ---- 予約 ----
  router.get('/reservations', async (req, res, next) => {
    try {
      // デフォルトは今日から14日先まで
      const from = req.query.from || null;
      const to = req.query.to || null;
      const { rows } = await pool.query(
        `SELECT r.id, r.reserved_at, r.menu, r.status, r.confirmed_by_customer,
                c.id AS customer_id, c.name AS customer_name, s.name AS staff_name
         FROM reservations r
         JOIN customers c ON c.id = r.customer_id
         LEFT JOIN staff s ON s.id = r.staff_id
         WHERE (r.reserved_at AT TIME ZONE 'Asia/Tokyo')::date
               BETWEEN COALESCE($1::date, (now() AT TIME ZONE 'Asia/Tokyo')::date)
                   AND COALESCE($2::date, (now() AT TIME ZONE 'Asia/Tokyo')::date + INTERVAL '14 day')
         ORDER BY r.reserved_at`,
        [from, to]
      );
      res.json({ reservations: rows });
    } catch (err) {
      next(err);
    }
  });

  router.post('/reservations', async (req, res, next) => {
    try {
      const { customerId, reservedAt, menu, staffId } = req.body ?? {};
      const result = await reservationService.createManual({
        customerId: Number(customerId),
        reservedAt,
        menu,
        staffId: staffId ? Number(staffId) : null,
      });
      if (!result.ok) return res.status(400).json(result);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.patch('/reservations/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid_id' });
      const result = await reservationService.setStatus(id, req.body?.status);
      if (!result.ok) {
        return res.status(result.error === 'not_found' ? 404 : 400).json(result);
      }
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
