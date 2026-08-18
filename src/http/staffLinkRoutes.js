// スタッフ登録（LIFF）。スタッフ用グループに置いたボタンから開く画面の裏側。
//
// 連携は「誰が」を取り違えると別人へ通知が飛び、シフト表と予約を触られる。
// そのため本人確認とグループ参加の2つを必ず通す（staffGate.js）。
// 連携済みかどうかは関門にしない。ここは「まだ連携していない人」が通る入口のため。
import express from 'express';
import { createStaffGate, statusForGate as statusFor } from './staffGate.js';

export function createStaffLinkRouter({
  verifyIdToken, settings, config, lineClient, shiftService,
}) {
  const router = express.Router();
  const staffGate = createStaffGate({ verifyIdToken, settings, config, lineClient, shiftService });
  const gate = (idToken) => staffGate.verifyInGroup(idToken);

  /**
   * 画面を開いたときの状態。ここを通った時点で本人＝グループの参加者であることは確かめてある。
   * 名簿そのものは返さない（名前は本人に入力してもらうので、画面に出す必要がない）。
   */
  router.post('/options', async (req, res, next) => {
    try {
      const result = await gate(req.body?.idToken);
      // 原因を追えるようにするが、LINE userId は残さない
      console.log(`[staff-link] liff options ok=${result.ok}${result.ok ? '' : ` reason=${result.error}`}`);
      if (!result.ok) return res.status(statusFor(result.error)).json({ eligible: false, error: result.error });

      // 既に登録済みなら、その名前を出して入れ直しの目安にしてもらう
      const linked = await shiftService.findStaffByLineUserId(result.lineUserId);
      res.json({ eligible: true, linkedStaff: linked ?? null });
    } catch (err) {
      next(err);
    }
  });

  /**
   * 登録。ふだんは入力された名前（name）で紐付ける。
   * 同姓が複数いて選んでもらったときだけ、その id（staffId）が送られてくる。
   */
  router.post('/link', async (req, res, next) => {
    try {
      const result = await gate(req.body?.idToken);
      if (!result.ok) return res.status(statusFor(result.error)).json({ ok: false, error: result.error });

      const { lineUserId } = result;
      let linked;
      if (req.body?.staffId != null) {
        const staffId = Number(req.body.staffId);
        if (!Number.isInteger(staffId) || staffId <= 0) {
          return res.status(400).json({ ok: false, error: 'invalid_staff' });
        }
        linked = await shiftService.linkStaffById({ lineUserId, staffId });
      } else {
        linked = await shiftService.linkStaffByTypedName({ lineUserId, name: req.body?.name });
      }

      console.log(`[staff-link] source=liff ok=${linked.ok}${linked.ok ? ` created=${Boolean(linked.created)}` : ` reason=${linked.error}`}`);
      if (!linked.ok) {
        // 名前の書き方の問題は 400、決められない・既に別人のものは 409 と分ける
        return res.status(linked.error === 'invalid_name' ? 400 : 409).json(linked);
      }

      res.json({ ok: true, staff: linked.staff, created: Boolean(linked.created) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
