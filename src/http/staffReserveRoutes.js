// スタッフ用の予約登録フォーム（LIFF）の裏側。
//
// 文章で送る予約登録（reservationEntry）はお名前の読み取りが当たらないことがあり、
// そのたびに送り直しになる。この画面では、探して選んでもらうことでお客様を確定させる。
// AI の読み取りは介在しないので、取り違えは起きない。
//
// 探し方は「飼い主様のお名前」「お電話番号」「わんちゃんのお名前」のどれでもよい。
// 現場ではわんちゃんの名前で覚えていることが多いため、そこから引けるようにしてある。
//
// 関門はスタッフ登録の画面と同じ（staffGate）。加えて、この画面は
// 「連携済みのスタッフ」であればグループの参加確認を通らなくても使える
// （1:1 のトークから開くため。連携そのものが本人確認済みの証になっている）。
import express from 'express';
import { createStaffGate, statusForGate as statusFor } from './staffGate.js';
import { normalizePhone } from '../customers/phone.js';
import { stayLabel } from '../reservations/stay.js';

// 一度に返す候補の上限。これを超えるほど曖昧なら、絞り込んでもらう
const MAX_CANDIDATES = 20;
const MAX_QUERY = 30;
const MAX_NAME = 60;
const MAX_NOTE = 500;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// クライアントは JST を明示して送る前提。端末のタイムゾーン設定に振り回されないため
const RESERVED_AT_RE = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:00\+09:00$/;

const text = (v, max) => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s && s.length <= max ? s : null;
};

// ILIKE のパターンとして解釈される文字を落とす。人名・犬名には出てこないので、
// エスケープするより消してしまう方が読みやすい
const forSearch = (q) => (text(q, MAX_QUERY) ?? '').replace(/[%_\\]/g, '');

// 電話番号は部分一致で探せるようにする（下4桁だけで探すことが多い）。
// normalizePhone は完全な番号しか通さないため、ここでは数字だけを取り出す。
// 1桁だと誰にでも当たってしまうので、2桁以上のときだけ番号として扱う
const digitsOf = (q) => {
  const d = q
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\D/g, '');
  return d.length >= 2 ? d : null;
};

export function createStaffReserveRouter({
  verifyIdToken, settings, config, lineClient, shiftService,
  pool, reservationService, drafts, store = null,
}) {
  const router = express.Router();
  const staffGate = createStaffGate({ verifyIdToken, settings, config, lineClient, shiftService });

  const ready = Boolean(pool && reservationService && drafts);

  /**
   * 本人確認 → 連携済みスタッフか、スタッフ用グループの参加者であること。
   * @returns {Promise<{ok: true, lineUserId, staff} | {ok: false, error}>}
   */
  async function gate(idToken) {
    if (!ready) return { ok: false, error: 'liff_not_configured' };
    const who = await staffGate.verify(idToken);
    if (!who.ok) return who;

    const staff = await shiftService.findStaffByLineUserId(who.lineUserId);
    if (staff) return { ok: true, lineUserId: who.lineUserId, staff };

    const member = await staffGate.inGroup(who.lineUserId);
    if (!member.ok) return member;
    return { ok: true, lineUserId: who.lineUserId, staff: null };
  }

  /** 画面を開いたとき。コース・担当の一覧と、自分が誰として登録されているかを返す */
  router.post('/options', async (req, res, next) => {
    try {
      const result = await gate(req.body?.idToken);
      console.log(`[resv-form] options ok=${result.ok}${result.ok ? '' : ` reason=${result.error}`}`);
      if (!result.ok) {
        return res.status(statusFor(result.error)).json({ eligible: false, error: result.error });
      }

      const [{ rows: menus }, { rows: staff }] = await Promise.all([
        pool.query(
          `SELECT id, name, duration_minutes FROM menus WHERE active = true ORDER BY sort_order, id`
        ),
        pool.query(`SELECT id, name FROM staff WHERE active = true ORDER BY id`),
      ]);

      res.json({
        eligible: true,
        // 担当の初期値に使う。連携していない人（グループから開いた人）は null
        me: result.staff ?? null,
        menus,
        staff,
        // 日時の初期値を営業時間に寄せるために渡す（画面側で店舗ごとに変えないため）
        openTime: store?.openTime ?? null,
        closeTime: store?.closeTime ?? null,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * お客様を探す。飼い主様のお名前・お電話番号・わんちゃんのお名前のどれでも引ける。
   * 選ぶのはスタッフなので候補を並べるだけにし、こちらでは1件に決めない。
   */
  router.post('/customers', async (req, res, next) => {
    try {
      const result = await gate(req.body?.idToken);
      if (!result.ok) {
        return res.status(statusFor(result.error)).json({ error: result.error });
      }

      const q = forSearch(req.body?.q);
      if (!q) return res.status(400).json({ error: 'invalid_query' });
      // 数字が含まれていなければ電話番号としては照合しない（NULL は LIKE に一致しない）
      const digits = digitsOf(q);

      const { rows } = await pool.query(
        `SELECT c.id, c.name, right(c.phone_norm, 4) AS phone_last4,
                COALESCE(
                  array_agg(p.name ORDER BY p.id) FILTER (WHERE p.name IS NOT NULL), '{}'
                ) AS pets
           FROM customers c
           LEFT JOIN pets p ON p.customer_id = c.id
          WHERE c.name ILIKE '%' || $1 || '%'
             OR c.phone_norm LIKE '%' || $2 || '%'
             OR EXISTS (
                  SELECT 1 FROM pets p2
                   WHERE p2.customer_id = c.id AND p2.name ILIKE '%' || $1 || '%'
                )
          GROUP BY c.id
          ORDER BY c.name, c.id
          LIMIT $3`,
        [q, digits, MAX_CANDIDATES]
      );

      // お客様の氏名は残さない。件数だけ分かれば追える
      console.log(`[resv-form] search hits=${rows.length}`);
      res.json({
        customers: rows.map((r) => ({
          id: Number(r.id),
          name: r.name,
          // 全桁は出さない。同姓の見分けが付けば足りる
          phoneLast4: r.phone_last4 ?? null,
          pets: r.pets ?? [],
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  /** 登録。フォームで確定した内容なので、下書きを挟まずそのまま予約にする */
  router.post('/create', async (req, res, next) => {
    try {
      const result = await gate(req.body?.idToken);
      if (!result.ok) {
        return res.status(statusFor(result.error)).json({ ok: false, error: result.error });
      }

      const body = req.body ?? {};
      if (!RESERVED_AT_RE.test(body.reservedAt ?? '')) {
        return res.status(400).json({ ok: false, error: 'invalid_reserved_at' });
      }

      const checkoutDate = text(body.checkoutDate, 10);
      if (checkoutDate && !DATE_RE.test(checkoutDate)) {
        return res.status(400).json({ ok: false, error: 'invalid_checkout' });
      }
      const stay = checkoutDate
        ? stayLabel({ reservedAt: body.reservedAt, checkoutDate })
        : null;
      if (checkoutDate && !stay) {
        return res.status(400).json({ ok: false, error: 'invalid_checkout' });
      }

      // 既存のお客様か、名前だけの新規か。どちらでもないものは受け付けない
      let customerId = null;
      let createdCustomer = false;
      if (body.customerId != null) {
        customerId = Number(body.customerId);
        if (!Number.isInteger(customerId) || customerId <= 0) {
          return res.status(400).json({ ok: false, error: 'invalid_customer' });
        }
      } else {
        const name = text(body.newCustomerName, MAX_NAME);
        if (!name) return res.status(400).json({ ok: false, error: 'invalid_customer' });
        // 電話番号が既存と重なる場合はその方に寄せる（重複した顧客を作らない）
        customerId = await drafts.createCustomer({
          name,
          phone: normalizePhone(body.newCustomerPhone),
        });
        createdCustomer = true;
      }

      const staffId = body.staffId ? Number(body.staffId) : null;
      if (staffId != null && (!Number.isInteger(staffId) || staffId <= 0)) {
        return res.status(400).json({ ok: false, error: 'invalid_staff' });
      }
      const duration = body.durationMinutes;
      const durationMinutes =
        duration == null || duration === '' ? null : Number(duration);

      // 退室日は reservations に列を持たない。予約一覧で見えるようメモの先頭へ置く
      const note = [stay ? `お泊まり ${stay}` : null, text(body.note, MAX_NOTE)]
        .filter(Boolean)
        .join('\n') || null;

      const created = await reservationService.createManual({
        customerId,
        reservedAt: body.reservedAt,
        menu: text(body.menu, MAX_NAME),
        staffId,
        durationMinutes,
        note,
      });
      if (!created.ok) return res.status(400).json({ ok: false, error: created.error });

      // 顧客は内部 id でのみ参照する（氏名はログに残さない）
      console.log(
        `[resv-form] registered res=${created.reservationId} customer=${customerId} new=${createdCustomer}`
      );
      res.json({ ok: true, createdCustomer, stay });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
