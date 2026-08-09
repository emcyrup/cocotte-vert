// 管理画面用 API。全ルートが Basic 認証（index.js 側で適用）配下にある前提。
import express from 'express';
import { normalizePhone } from '../customers/phone.js';
import { buildPreReminderMessage } from '../line/messages/preReminder.js';
import { buildAfterVisitMessage } from '../line/messages/afterVisit.js';
import { buildDormantMessage } from '../line/messages/dormant.js';
import { buildBirthdayMessage } from '../line/messages/birthday.js';

export function createAdminRouter({ pool, reservationService, lineClient, config, shiftService = null }) {
  const router = express.Router();

  // ---- スタッフ ----
  // 予約フォームの担当選択にも使うため、既定では在職者のみ。
  // スタッフ情報画面は ?all=1 で退職者も含めて取得する
  router.get('/staff', async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, name, active, line_user_id, (line_user_id IS NOT NULL) AS line_linked
         FROM staff WHERE ($1 = '1' OR active = true) ORDER BY id`,
        [req.query.all === '1' ? '1' : '0']
      );
      res.json({ staff: rows });
    } catch (err) {
      next(err);
    }
  });

  // スタッフグループへの参加状況。LINE への問い合わせを伴うため一覧とは分けている
  router.get('/staff/line-status', async (_req, res, next) => {
    try {
      if (!shiftService) return res.status(503).json({ error: 'shift_disabled' });
      res.json(await shiftService.listStaffLineStatus());
    } catch (err) {
      next(err);
    }
  });

  // スタッフ情報の編集。LINE ID は連携コードを使わず直接設定・解除もできる
  router.patch('/staff/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid_id' });
      const { name, active, lineUserId } = req.body ?? {};
      if (!name?.trim()) return res.status(400).json({ error: 'invalid_name' });

      let userId = null;
      if (lineUserId?.trim()) {
        userId = lineUserId.trim();
        // LINE の userId は U + 16進32桁。取り違えると別人へ通知が飛ぶため形式を検証する
        if (!/^U[0-9a-f]{32}$/.test(userId)) return res.status(400).json({ error: 'invalid_line_user_id' });
        const { rows: dup } = await pool.query(
          `SELECT id FROM staff WHERE line_user_id = $1 AND id <> $2`,
          [userId, id]
        );
        if (dup.length > 0) return res.status(409).json({ error: 'line_user_id_exists' });
      }

      const { rowCount } = await pool.query(
        `UPDATE staff SET name = $2, active = $3, line_user_id = $4 WHERE id = $1`,
        [id, name.trim(), active !== false, userId]
      );
      if (rowCount === 0) return res.status(404).json({ error: 'not_found' });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // シフト申請に使う LINE 連携の合言葉を発行する。
  // スタッフ本人が公式LINE へ送ると紐付く（userId は本人から見えないため、この方式にしている）
  router.post('/staff/:id/link-code', async (req, res, next) => {
    try {
      if (!shiftService) return res.status(503).json({ error: 'shift_disabled' });
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid_id' });
      const result = await shiftService.issueLinkCode(id);
      if (!result.ok) return res.status(404).json(result);
      res.json(result);
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

  // ---- メニュー（LIFF 予約フォームの選択肢）----
  router.get('/menus', async (_req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, name, duration_minutes, active FROM menus ORDER BY sort_order, id`
      );
      res.json({ menus: rows });
    } catch (err) {
      next(err);
    }
  });

  router.post('/menus', async (req, res, next) => {
    try {
      const name = req.body?.name?.trim();
      if (!name) return res.status(400).json({ error: 'invalid_name' });
      const duration = req.body?.durationMinutes ? Number(req.body.durationMinutes) : null;
      if (duration !== null && (!Number.isInteger(duration) || duration <= 0)) {
        return res.status(400).json({ error: 'invalid_duration' });
      }
      const { rows } = await pool.query(
        `INSERT INTO menus (name, duration_minutes, sort_order)
         VALUES ($1, $2, COALESCE((SELECT max(sort_order) + 1 FROM menus), 0))
         RETURNING id, name, duration_minutes, active`,
        [name, duration]
      );
      res.json({ ok: true, menu: rows[0] });
    } catch (err) {
      next(err);
    }
  });

  // 過去の予約が参照している可能性があるため削除はせず、有効/無効の切り替えにする
  router.patch('/menus/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid_id' });
      const { rows } = await pool.query(
        `UPDATE menus SET active = $2 WHERE id = $1 RETURNING id`,
        [id, Boolean(req.body?.active)]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
      res.json({ ok: true });
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
        `SELECT c.id, c.name, c.phone_norm, c.birthday, c.last_visit_at, c.opt_out, c.is_blocked,
                (c.line_user_id IS NOT NULL) AS line_linked,
                (SELECT string_agg(p.name, '・' ORDER BY p.id) FROM pets p WHERE p.customer_id = c.id) AS pet_names
         FROM customers c
         WHERE ($1 = '' OR c.name ILIKE '%' || $1 || '%' OR ($2::text IS NOT NULL AND c.phone_norm LIKE $2 || '%')
                OR EXISTS (SELECT 1 FROM pets p WHERE p.customer_id = c.id AND p.name ILIKE '%' || $1 || '%'))
         ORDER BY c.id DESC
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

  // 顧客情報の編集（管理画面の顧客管理から）。
  // phone は空を許す（LINE 経由で登録され電話未登録の顧客がいるため）
  router.patch('/customers/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid_id' });
      const { name, phone, birthday, optOut } = req.body ?? {};
      if (!name?.trim()) return res.status(400).json({ error: 'invalid_name' });
      let phoneNorm = null;
      if (phone?.trim()) {
        phoneNorm = normalizePhone(phone);
        if (!phoneNorm) return res.status(400).json({ error: 'invalid_phone' });
        const { rows: dup } = await pool.query(
          `SELECT id FROM customers WHERE phone_norm = $1 AND id <> $2`,
          [phoneNorm, id]
        );
        if (dup.length > 0) return res.status(409).json({ error: 'phone_exists' });
      }
      if (birthday && !/^\d{4}-\d{2}-\d{2}$/.test(birthday)) {
        return res.status(400).json({ error: 'invalid_birthday' });
      }
      const { rowCount } = await pool.query(
        `UPDATE customers
         SET name = $2, phone_norm = $3, birthday = $4, opt_out = $5, updated_at = now()
         WHERE id = $1`,
        [id, name.trim(), phoneNorm, birthday || null, Boolean(optOut)]
      );
      if (rowCount === 0) return res.status(404).json({ error: 'not_found' });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // 顧客の削除。ペット・予約・配信ログも外部キーの CASCADE で一緒に消える。
  // 取り消せないため、何を巻き込んだかを呼び出し元へ返して画面で伝えられるようにする
  router.delete('/customers/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid_id' });
      const { rows: counts } = await pool.query(
        `SELECT (SELECT count(*) FROM pets WHERE customer_id = $1) AS pets,
                (SELECT count(*) FROM reservations WHERE customer_id = $1) AS reservations`,
        [id]
      );
      const { rowCount } = await pool.query(`DELETE FROM customers WHERE id = $1`, [id]);
      if (rowCount === 0) return res.status(404).json({ error: 'not_found' });
      res.json({
        ok: true,
        deleted: {
          pets: Number(counts[0].pets),
          reservations: Number(counts[0].reservations),
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // ---- ペット ----
  const validatePet = (body) => {
    const { name, breed, birthday, notes } = body ?? {};
    if (!name?.trim()) return { error: 'invalid_name' };
    if (birthday && !/^\d{4}-\d{2}-\d{2}$/.test(birthday)) return { error: 'invalid_birthday' };
    return {
      name: name.trim(),
      breed: breed?.trim() || null,
      birthday: birthday || null,
      notes: notes?.trim() || null,
    };
  };

  router.get('/customers/:id/pets', async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, name, breed, birthday, notes FROM pets WHERE customer_id = $1 ORDER BY id`,
        [Number(req.params.id)]
      );
      res.json({ pets: rows });
    } catch (err) {
      next(err);
    }
  });

  router.post('/customers/:id/pets', async (req, res, next) => {
    try {
      const customerId = Number(req.params.id);
      const pet = validatePet(req.body);
      if (pet.error) return res.status(400).json({ error: pet.error });
      const { rows: exists } = await pool.query(`SELECT 1 FROM customers WHERE id = $1`, [customerId]);
      if (exists.length === 0) return res.status(404).json({ error: 'customer_not_found' });
      const { rows } = await pool.query(
        `INSERT INTO pets (customer_id, name, breed, birthday, notes)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [customerId, pet.name, pet.breed, pet.birthday, pet.notes]
      );
      res.json({ ok: true, petId: rows[0].id });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/pets/:id', async (req, res, next) => {
    try {
      const pet = validatePet(req.body);
      if (pet.error) return res.status(400).json({ error: pet.error });
      const { rowCount } = await pool.query(
        `UPDATE pets SET name = $2, breed = $3, birthday = $4, notes = $5, updated_at = now()
         WHERE id = $1`,
        [Number(req.params.id), pet.name, pet.breed, pet.birthday, pet.notes]
      );
      if (rowCount === 0) return res.status(404).json({ error: 'not_found' });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/pets/:id', async (req, res, next) => {
    try {
      const { rowCount } = await pool.query(`DELETE FROM pets WHERE id = $1`, [Number(req.params.id)]);
      if (rowCount === 0) return res.status(404).json({ error: 'not_found' });
      res.json({ ok: true });
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
        `SELECT r.id, r.reserved_at, r.menu, r.status, r.confirmed_by_customer, r.note,
                c.id AS customer_id, c.name AS customer_name, s.name AS staff_name
         FROM reservations r
         JOIN customers c ON c.id = r.customer_id
         LEFT JOIN staff s ON s.id = r.staff_id
         WHERE (r.reserved_at AT TIME ZONE 'Asia/Tokyo')::date
               BETWEEN COALESCE($1::date, (now() AT TIME ZONE 'Asia/Tokyo')::date)
                   AND COALESCE($2::date, (now() AT TIME ZONE 'Asia/Tokyo')::date + INTERVAL '14 day')
            -- 承認待ちは期間外でも必ず表示する（対応漏れを防ぐため）
            OR (r.status = 'requested' AND r.reserved_at > now())
         ORDER BY (r.status = 'requested') DESC, r.reserved_at`,
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

  // ---- シフト変更申請（公式LINE から届いたもの）----
  router.get('/shift-requests', async (req, res, next) => {
    try {
      if (!shiftService) return res.status(503).json({ error: 'shift_disabled' });
      const status = req.query.status || null;
      if (status && !['pending', 'approved', 'rejected'].includes(status)) {
        return res.status(400).json({ error: 'invalid_status' });
      }
      res.json({ requests: await shiftService.listRequests({ status }) });
    } catch (err) {
      next(err);
    }
  });

  // 承認・却下。結果は申請したスタッフへ LINE で自動通知される
  router.patch('/shift-requests/:id', async (req, res, next) => {
    try {
      if (!shiftService) return res.status(503).json({ error: 'shift_disabled' });
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid_id' });
      const result = await shiftService.decide({ id, status: req.body?.status });
      if (!result.ok) {
        return res.status(result.error === 'not_found' ? 404 : 400).json(result);
      }
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // ---- 週次シフト ----
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  const SHIFT_KINDS = ['work', 'am', 'pm', 'koukyu', 'yukyu', 'jikan'];

  router.get('/shifts', async (req, res, next) => {
    try {
      if (!shiftService) return res.status(503).json({ error: 'shift_disabled' });
      const { from, to } = req.query;
      if (!DATE_RE.test(from ?? '') || !DATE_RE.test(to ?? '')) {
        return res.status(400).json({ error: 'invalid_range' });
      }
      res.json(await shiftService.listShifts({ from, to }));
    } catch (err) {
      next(err);
    }
  });

  // 1マス分の入力。kind を省略（null）すると未入力に戻す
  router.put('/shifts', async (req, res, next) => {
    try {
      if (!shiftService) return res.status(503).json({ error: 'shift_disabled' });
      const { staffId, date, kind, startTime, endTime } = req.body ?? {};
      const id = Number(staffId);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'invalid_staff' });
      if (!DATE_RE.test(date ?? '')) return res.status(400).json({ error: 'invalid_date' });
      if (kind && !SHIFT_KINDS.includes(kind)) return res.status(400).json({ error: 'invalid_kind' });
      // 時間休は時刻が揃っていないと勤怠として成立しない
      if (kind === 'jikan') {
        if (!TIME_RE.test(startTime ?? '') || !TIME_RE.test(endTime ?? '')) {
          return res.status(400).json({ error: 'invalid_time' });
        }
        if (startTime >= endTime) return res.status(400).json({ error: 'invalid_time_order' });
      }
      res.json(await shiftService.upsertShift({ staffId: id, date, kind: kind || null, startTime, endTime }));
    } catch (err) {
      next(err);
    }
  });

  // ---- 配信メッセージのテスト送信 ----
  // 日付条件を待たずに各ジョブの実物メッセージを確認するための機能。
  // 宛先は常に TEST_LINE_USER_ID（lineClient.pushTest 側で保証）。
  router.post('/test-message', async (req, res, next) => {
    try {
      const { type, reservationId, customerId } = req.body ?? {};
      let message;

      if (type === 'preReminder' || type === 'afterVisit') {
        const id = Number(reservationId);
        if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid_reservation' });
        const { rows } = await pool.query(
          `SELECT r.id, r.reserved_at, r.menu, c.name AS customer_name, s.name AS staff_name
           FROM reservations r
           JOIN customers c ON c.id = r.customer_id
           LEFT JOIN staff s ON s.id = r.staff_id
           WHERE r.id = $1`,
          [id]
        );
        const r = rows[0];
        if (!r) return res.status(404).json({ error: 'reservation_not_found' });
        message =
          type === 'preReminder'
            ? buildPreReminderMessage({
                customerName: r.customer_name,
                reservedAt: r.reserved_at,
                menu: r.menu,
                staffName: r.staff_name,
                reservationId: r.id,
              })
            : buildAfterVisitMessage({ customerName: r.customer_name, reservationId: r.id });
      } else if (type === 'dormant' || type === 'birthday') {
        const id = Number(customerId);
        if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid_customer' });
        const { rows } = await pool.query(`SELECT id, name FROM customers WHERE id = $1`, [id]);
        const c = rows[0];
        if (!c) return res.status(404).json({ error: 'customer_not_found' });
        message =
          type === 'dormant'
            ? buildDormantMessage({ customerName: c.name })
            : buildBirthdayMessage({ customerName: c.name, couponUrl: config.birthdayCouponUrl });
      } else {
        return res.status(400).json({ error: 'invalid_type' });
      }

      const result = await lineClient.pushTest([message]);
      if (result.status === 'refused') {
        return res.status(400).json({
          ok: false,
          error: 'live_mode',
          message: 'SEND_MODE=live ではテスト送信できません（誤配信防止）',
        });
      }
      res.json({ ok: true, mode: result.status });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
