// スタッフからの 1:1 メッセージを、LINE 連携とシフト変更申請として処理する。
//
// 顧客の発言を巻き込まないための線引き:
//   - 1:1 のトークのみ（グループの雑談は対象外）
//   - 連携済みスタッフの line_user_id と一致する発言だけを申請の解釈に回す
// 未連携の相手の発言は false を返し、従来どおり顧客向けの処理へ委ねる。

import { formatShift } from '../../shifts/service.js';

// 連携の合言葉。顧客が偶然送る文面と衝突しないよう、接頭辞を必須にする
const LINK_COMMAND_RE = /^(?:スタッフ(?:登録|連携)|shift\s*link)[\s　:：]*(\d{6})$/i;

const jstDateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function createStaffShiftHandler({ shiftService, shiftParser, lineClient, slack, now = () => new Date() }) {
  async function replyText(event, text) {
    if (event.replyToken) {
      await lineClient.reply(event.replyToken, [{ type: 'text', text }]);
    }
  }

  async function handleLink(event, code) {
    const result = await shiftService.linkStaffByCode({
      lineUserId: event.source.userId,
      code,
    });
    if (!result.ok) {
      await replyText(
        event,
        '連携コードを確認できませんでした。\n有効期限が切れている可能性があります。店長に再発行をご依頼ください。'
      );
      return true;
    }
    await replyText(
      event,
      `${result.staff.name}さん、連携しました。\n` +
        'このトークにシフトのご希望をそのまま送っていただければ、申請として店長に届きます。\n' +
        '例：8/1 有休でお願いします'
    );
    return true;
  }

  /**
   * @returns {Promise<boolean>} 処理したら true（顧客向けの処理へは渡さない）
   */
  return async function handleStaffShift(event, text) {
    if (event.source?.type !== 'user' || !event.source.userId) return false;

    const linkMatch = LINK_COMMAND_RE.exec(text.trim());
    if (linkMatch) return handleLink(event, linkMatch[1]);

    const staff = await shiftService.findStaffByLineUserId(event.source.userId);
    if (!staff) return false;

    const parsed = await shiftParser.parse({ text, today: jstDateFmt.format(now()) });
    if (!parsed.isRequest) {
      await replyText(
        event,
        'シフトの申請として読み取れませんでした。\n' +
          'お手数ですが、日付と種別を入れて送ってください。\n' +
          '例：8/1 有休 ／ 7/31 10時から12時まで時間休'
      );
      return true;
    }

    const { created, replaced } = await shiftService.createRequests({
      staffId: staff.id,
      entries: parsed.entries,
      rawText: text,
    });
    const lines = created.map((r) => `・${formatShift(r)}`).join('\n');

    await replyText(
      event,
      'シフト変更を受け付けました。\n' +
        `${staff.name}さん\n${lines}\n` +
        (replaced > 0 ? '（同じ日の申請は今回の内容で上書きしました）\n' : '') +
        '店長の承認後にシフト表へ反映されます。'
    );

    // 承認待ちが溜まっていることに気付けるよう、店長側にも知らせる
    await slack.notify(
      `:calendar: *シフト変更の申請*\n${staff.name}さん（staff=${staff.id}）\n${lines}\n` +
        `申請本文:\n> ${text}`
    );
    return true;
  };
}
