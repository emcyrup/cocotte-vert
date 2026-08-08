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

function normalize(text) {
  return text.replace(/[\s　]/g, '').replace(/[?？!！。、]/g, '');
}

export function createStaffCommandHandler({ settings, lineClient, config }) {
  async function resolveGroupId() {
    const stored = await settings.get(SETTING_KEYS.staffLineGroupId).catch(() => null);
    return stored ?? config?.staffLineGroupId ?? null;
  }

  /**
   * スタッフグループからのコマンドなら処理して true を返す。
   * それ以外（顧客の発言・未設定のグループ）は false を返し、通常の処理へ委ねる。
   */
  return async function handleStaffCommand(event, text) {
    if (event.source?.type !== 'group') return false;

    const command = COMMANDS[normalize(text)];
    if (!command) return false;

    const staffGroupId = await resolveGroupId();
    if (!staffGroupId || event.source.groupId !== staffGroupId) return false;

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
