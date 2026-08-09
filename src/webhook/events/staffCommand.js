// スタッフ用グループからの問い合わせコマンド。
//
// 日次ジョブの結果は Push すると1通ごとに通数を消費するため、実行時は保存だけしておき、
// グループで「配信結果」と聞かれたときに応答メッセージで返す（応答は通数を消費しない）。
//
// 顧客が同じ言葉を送っても反応しないよう、**スタッフ通知先に設定済みのグループからの
// 発言だけ**を受け付ける。店内の数字を第三者に読ませないため。
import { SETTING_KEYS } from '../../settings.js';
import { toPlainText } from '../../notify/staffNotifier.js';

// 表記ゆれを吸収する。スペースと記号だけ落として比較する
const COMMANDS = {
  配信結果: 'jobSummary',
  ジョブ結果: 'jobSummary',
  実行結果: 'jobSummary',
};

// グループでの LINE 連携。名前でも、管理画面で発行した6桁の連携コードでも紐付けられる
// （どちらを送るか迷わせないため、同じ言い回しで両方を受け付ける）
const LINK_COMMAND_RE = /^(?:スタッフ(?:登録|連携)|シフト登録)[\s　:：]+(.+)$/;
const LINK_CODE_RE = /^\d{6}$/;

function normalize(text) {
  return text.replace(/[\s　]/g, '').replace(/[?？!！。、]/g, '');
}

export function createStaffCommandHandler({ settings, lineClient, config, shiftService = null }) {
  async function resolveGroupId() {
    const stored = await settings.get(SETTING_KEYS.staffLineGroupId).catch(() => null);
    return stored ?? config?.staffLineGroupId ?? null;
  }

  /**
   * スタッフグループからのコマンドなら処理して true を返す。
   * それ以外（顧客の発言・未設定のグループ）は false を返し、通常の処理へ委ねる。
   */
  async function handleLink(event, arg) {
    const lineUserId = event.source.userId;
    // 6桁の数字は管理画面で発行した連携コード。名前と取り違えないよう先に判定する
    const byCode = LINK_CODE_RE.test(arg);
    const result = byCode
      ? await shiftService.linkStaffByCode({ lineUserId, code: arg })
      : await shiftService.linkStaffByName({ lineUserId, name: arg });

    const messages = {
      invalid_code: '連携コードを確認できませんでした。\n有効期限が切れている可能性があります。店長に再発行をご依頼ください。',
      not_found: `「${arg}」というスタッフが見つかりません。店舗管理画面に登録された名前で送ってください。`,
      ambiguous: `「${arg}」に当てはまるスタッフが複数います。店舗管理画面から LINE ID を直接設定してください。`,
      already_linked_to_other: 'この LINE アカウントは既に別のスタッフに紐付いています。',
    };
    const body = result.ok
      ? `${result.staff.name}さんのLINEアカウントを連携しました。\n` +
        'これから、Botとの1対1のトークにシフトのご希望を送っていただければ申請できます。\n' +
        '例：8/1 有休でお願いします'
      : messages[result.error];
    if (event.replyToken) {
      await lineClient.reply(event.replyToken, [{ type: 'text', text: body }]);
    }
    return true;
  }

  return async function handleStaffCommand(event, text) {
    if (event.source?.type !== 'group') return false;

    const linkMatch = shiftService && event.source.userId ? LINK_COMMAND_RE.exec(text.trim()) : null;
    const command = COMMANDS[normalize(text)];
    if (!command && !linkMatch) return false;

    const staffGroupId = await resolveGroupId();
    if (!staffGroupId || event.source.groupId !== staffGroupId) return false;

    if (linkMatch) return handleLink(event, linkMatch[1].trim());

    if (command === 'jobSummary') {
      const summary = await settings.get(SETTING_KEYS.lastJobSummary);
      const body = summary
        ? toPlainText(summary)
        : 'まだ実行結果がありません。配信ジョブは毎朝10時に動きます。';
      if (event.replyToken) {
        await lineClient.reply(event.replyToken, [{ type: 'text', text: body }]);
      }
      return true;
    }
    return false;
  };
}
