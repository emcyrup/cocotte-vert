// message イベント: 電話番号らしき文字列なら突合を試行する（補助経路）。
// それ以外のテキストはフォロー回答の分類（Phase 4）で扱うため、ここでは何もしない。
import { looksLikePhone } from '../../customers/phone.js';

export function createMessageHandler({ lineClient, linkService }) {
  return async function handleMessage(event) {
    if (event.message?.type !== 'text') return;
    const text = event.message.text ?? '';
    if (!looksLikePhone(text)) return;

    const lineUserId = event.source?.userId;
    if (!lineUserId) return;

    // 突合失敗時の Slack 通知に表示名を添える（取れなくても処理は続行）
    let displayName = null;
    try {
      const profile = await lineClient.getProfile(lineUserId);
      displayName = profile?.displayName ?? null;
    } catch {
      // プロフィール非公開でも突合は行う
    }

    const result = await linkService.linkByPhoneText({ lineUserId, displayName, text });

    if (event.replyToken) {
      const replyText =
        result.outcome === 'linked'
          ? 'ご登録ありがとうございます。お客様情報とお繋ぎしました。'
          : 'お電話番号を確認のうえ、担当者よりご連絡いたします。少々お待ちください。';
      await lineClient.reply(event.replyToken, [{ type: 'text', text: replyText }], {
        customerId: result.customerId,
      });
    }
  };
}
