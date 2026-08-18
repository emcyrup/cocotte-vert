// スタッフ用 LIFF 画面の関門。
//
// スタッフ登録・予約登録のどちらも、「誰が開いたか」を取り違えると被害が大きい。
// 判定はサーバー側にまとめ、画面（クライアント）の申告は一切信用しない。
//   ① LINE の ID トークンをサーバーで検証する（クライアントの言う userId は使わない）
//   ② その人がスタッフ用グループにいることを LINE へ問い合わせる
//
// ②があるので、画面の URL が外へ漏れても、グループ外の人は操作できない。
import { SETTING_KEYS } from '../settings.js';

export function createStaffGate({ verifyIdToken, settings, config, lineClient, shiftService }) {
  async function resolveGroupId() {
    const stored = await settings.get(SETTING_KEYS.staffLineGroupId).catch(() => null);
    return stored ?? config?.staffLineGroupId ?? null;
  }

  /** ID トークンの検証だけ。@returns {Promise<{ok: true, lineUserId} | {ok: false, error}>} */
  async function verify(idToken) {
    if (!verifyIdToken || !shiftService) return { ok: false, error: 'liff_not_configured' };
    try {
      const payload = await verifyIdToken(idToken);
      return { ok: true, lineUserId: payload.sub };
    } catch {
      return { ok: false, error: 'invalid_token' };
    }
  }

  /** スタッフ用グループにいるか。確かめられないときは「いない」側に倒す */
  async function inGroup(lineUserId) {
    const groupId = await resolveGroupId();
    if (!groupId) return { ok: false, error: 'group_not_configured' };

    const membership = await lineClient.getGroupMembership(groupId, lineUserId);
    if (membership === 'left') return { ok: false, error: 'not_in_group' };
    // 'unknown'（通信・権限エラー）は参加していると見なさない。安全側に倒す
    if (membership !== 'joined') return { ok: false, error: 'membership_unknown' };
    return { ok: true };
  }

  /** 本人確認とグループ参加の両方を通す */
  async function verifyInGroup(idToken) {
    const who = await verify(idToken);
    if (!who.ok) return who;
    const member = await inGroup(who.lineUserId);
    return member.ok ? who : member;
  }

  return { verify, inGroup, verifyInGroup };
}

/** 認証の失敗だけ 401、それ以外（権限・設定）は 403 */
export const statusForGate = (error) => (error === 'invalid_token' ? 401 : 403);
