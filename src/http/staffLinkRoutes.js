// スタッフ登録（LIFF）。スタッフ用グループに置いたボタンから開く画面の裏側。
//
// 連携は「誰が」を取り違えると別人へ通知が飛び、シフト表と予約を触られる。
// そのため2つの関門を必ず通す。片方でも確かめられなければ登録させない。
//   ① LINE の ID トークンをサーバーで検証する（クライアントの言う userId は信用しない）
//   ② その人がスタッフ用グループにいることを LINE へ問い合わせる
//
// ②があるので、この画面の URL が外へ漏れても、グループ外の人は登録できない。
import express from 'express';
import { SETTING_KEYS } from '../settings.js';

export function createStaffLinkRouter({
  verifyIdToken, settings, config, lineClient, shiftService, slack,
}) {
  const router = express.Router();

  async function resolveGroupId() {
    const stored = await settings.get(SETTING_KEYS.staffLineGroupId).catch(() => null);
    return stored ?? config?.staffLineGroupId ?? null;
  }

  /** @returns {Promise<{ok: true, lineUserId: string} | {ok: false, error: string}>} */
  async function gate(idToken) {
    if (!verifyIdToken || !shiftService) return { ok: false, error: 'liff_not_configured' };

    let payload;
    try {
      payload = await verifyIdToken(idToken);
    } catch {
      return { ok: false, error: 'invalid_token' };
    }

    const groupId = await resolveGroupId();
    if (!groupId) return { ok: false, error: 'group_not_configured' };

    const membership = await lineClient.getGroupMembership(groupId, payload.sub);
    if (membership === 'left') return { ok: false, error: 'not_in_group' };
    // 'unknown'（通信・権限エラー）は参加していると見なさない。安全側に倒す
    if (membership !== 'joined') return { ok: false, error: 'membership_unknown' };

    return { ok: true, lineUserId: payload.sub };
  }

  const statusFor = (error) => (error === 'invalid_token' ? 401 : 403);

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
        // createNew は「同じ名前の人が既にいるが、自分は別人だ」と答えられたときだけ立つ
        linked = await shiftService.linkStaffByTypedName({
          lineUserId,
          name: req.body?.name,
          createNew: req.body?.createNew === true,
        });
      }

      console.log(`[staff-link] source=liff ok=${linked.ok}${linked.ok ? ` created=${Boolean(linked.created)}` : ` reason=${linked.error}`}`);
      if (!linked.ok) {
        // 名前の書き方の問題は 400、決められない・既に別人のものは 409 と分ける
        return res.status(linked.error === 'invalid_name' ? 400 : 409).json(linked);
      }

      // 誰がスタッフになったかは後から追えるようにしておく（乗っ取りに気付けるように）。
      // 退職者と同じ名前で新しく作られたときは、本人の復帰を取り違えている可能性があるため添える
      await slack.notify(
        `:bust_in_silhouette: ${linked.staff.name}さん（staff=${linked.staff.id}）が` +
          `スタッフ登録しました${linked.created ? '（名簿に無かったため新しく作成）' : ''}。\n` +
          (linked.sameNameRetired
            ? '※同じお名前の退職者がいます。ご本人の復帰であれば、退職の方を「在職中」に戻し、' +
              '新しく作られた方を削除してください。\n'
            : '') +
          '心当たりがない場合はご確認ください。'
      );
      res.json({ ok: true, staff: linked.staff, created: Boolean(linked.created) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
