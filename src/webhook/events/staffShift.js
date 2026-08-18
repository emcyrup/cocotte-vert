// スタッフからの 1:1 メッセージを、LINE 連携とシフト変更申請として処理する。
//
// 顧客の発言を巻き込まないための線引き:
//   - 1:1 のトークのみ（グループの雑談は対象外）
//   - 連携済みスタッフの line_user_id と一致する発言だけを申請の解釈に回す
// 未連携の相手の発言は false を返し、従来どおり顧客向けの処理へ委ねる。

import { formatShift } from '../../shifts/service.js';
import { parseLinkCommand, parseBareCode } from './linkCommand.js';

const jstDateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// 本人の返事。ボタンでも文字でも受けられるようにする（LINE では文字で返す人が多い）
const ANSWERS = [
  { answer: 'confirm', re: /^(確定|かくてい|OK|ok|オーケー|はい|お願いします|おねがいします|これでお願いします)$/ },
  { answer: 'hold', re: /^(保留|ほりゅう|一旦保留|いったん保留|保留で|考えます)$/ },
  { answer: 'cancel', re: /^(やめる|キャンセル|取消|取り消し|なし|やっぱりなし|やめます)$/ },
];

export function parseShiftAnswer(text) {
  const t = String(text ?? '').replace(/[\s　]/g, '').replace(/[。、!！?？]/g, '');
  return ANSWERS.find((a) => a.re.test(t))?.answer ?? null;
}

/** 内容を確認して、確定・保留・やめる を選ばせる */
function confirmMessage({ staffName, lines }) {
  return {
    type: 'flex',
    altText: 'シフト変更の内容確認',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'md',
        contents: [
          { type: 'text', text: 'この内容でよろしいですか？', weight: 'bold', size: 'md' },
          { type: 'text', text: `${staffName}さん`, size: 'sm', color: '#888888' },
          { type: 'text', text: lines, size: 'sm', wrap: true },
          {
            type: 'text',
            text: '「確定」でシフト表に反映します。迷っているときは「保留」を押すと、店長が確認します。',
            size: 'xs', color: '#888888', wrap: true, margin: 'md',
          },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          {
            type: 'button', style: 'primary',
            action: { type: 'postback', label: '確定', data: 'action=shift&v=confirm', displayText: '確定' },
          },
          {
            type: 'button', style: 'secondary',
            action: { type: 'postback', label: '保留', data: 'action=shift&v=hold', displayText: '保留' },
          },
          {
            type: 'button', style: 'link', height: 'sm',
            action: { type: 'postback', label: 'やめる', data: 'action=shift&v=cancel', displayText: 'やめる' },
          },
        ],
      },
    },
  };
}

/** 返事を受けたあとの本文。呼び出し側（postback / テキスト）で共通に使う */
export function answerResultText({ answer, lines }) {
  if (answer === 'confirm') return `シフト表に反映しました。\n${lines}`;
  if (answer === 'hold') return `保留にしました。\n${lines}\n店長が確認しますので、少々お待ちください。`;
  return `取りやめました。\n${lines}\n入れ直す場合は、もう一度お送りください。`;
}

const NO_PENDING_TEXT =
  '確認待ちのシフト変更はありません。\n' +
  'シフトのご希望をそのままお送りください。\n例：8/1 有休でお願いします';

/**
 * 本人の返事（確定・保留・やめる）を反映して、本人と店長の双方へ知らせる。
 * 文字でもボタンでも同じ処理に入れたいので、テキスト側と postback 側で共有する。
 */
export function createShiftAnswerHandler({ shiftService, lineClient, slack }) {
  // 保留は店長が引き取る必要があるため必ず届ける。確定・取りやめも、
  // シフト表が本人の操作で変わる運用になった以上、店長が後から追えるように残す
  async function notifyDecision({ staff, answer, lines }) {
    const head = {
      confirm: ':white_check_mark: *シフト変更が確定しました*',
      hold: ':warning: *シフト変更が保留になりました*',
      cancel: ':leftwards_arrow_with_hook: *シフト変更が取りやめになりました*',
    }[answer];
    const tail = {
      confirm: 'シフト表へ反映済みです。',
      hold: '本人が判断に迷っています。管理画面の「シフト変更の申請」からご確認ください。',
      cancel: '本人が取りやめました。対応は不要です。',
    }[answer];
    await slack.notify(`${head}\n${staff.name}さん（staff=${staff.id}）\n${lines}\n${tail}`);
  }

  /**
   * @param {object|null} known 既に引いてあるスタッフ（テキスト経路では使い回す）
   * @returns {Promise<boolean>} 連携済みスタッフの返事として処理したら true
   */
  return async function handleShiftAnswer(event, answer, known = null) {
    const lineUserId = event.source?.userId;
    if (event.source?.type !== 'user' || !lineUserId) return false;
    const staff = known ?? (await shiftService.findStaffByLineUserId(lineUserId));
    if (!staff) return false;

    const result = await shiftService.answerOwnRequests({ staffId: staff.id, answer });
    const lines = result.ok ? result.requests.map((r) => `・${formatShift(r)}`).join('\n') : '';

    if (event.replyToken) {
      const text = result.ok ? answerResultText({ answer, lines }) : NO_PENDING_TEXT;
      await lineClient.reply(event.replyToken, [{ type: 'text', text }]);
    }
    // 状況を追えるようにするが、LINE userId は残さない
    console.log(`[staff-shift] answer=${answer} staff=${staff.id} ok=${result.ok}`);
    if (result.ok) await notifyDecision({ staff, answer, lines });
    return true;
  };
}

const linkedMessage = (name) =>
  `${name}さん、連携しました。\n` +
  'このトークにシフトのご希望をそのまま送ってください。\n' +
  '内容を確認のうえお返ししますので、よろしければ「確定」を押すとシフト表に入ります。\n' +
  '例：8/1 有休でお願いします';

export function createStaffShiftHandler({ shiftService, shiftParser, lineClient, slack, now = () => new Date() }) {
  const handleShiftAnswer = createShiftAnswerHandler({ shiftService, lineClient, slack });

  async function replyText(event, text) {
    if (event.replyToken) {
      await lineClient.reply(event.replyToken, [{ type: 'text', text }]);
    }
  }

  // 1:1 では6桁の連携コードだけを受け付ける。名前での連携を許すと、名前さえ知っていれば
  // 誰でもそのスタッフに成りすませてしまうため、名前はスタッフグループ限定にしている
  async function handleLink(event, { arg, isCode }) {
    if (!isCode) {
      // 名前で送られた場合。ここで黙って落とすと顧客向けの処理に流れ、
      // 送った本人には何も返らないため、送り方を案内する
      await replyText(
        event,
        'このトークでは6桁の連携コードで登録できます。\n' +
          '例：スタッフ登録 123456\n' +
          'コードは店長が店舗管理画面から発行できます。\n' +
          'お名前での登録は、スタッフ用のLINEグループでのみ受け付けています。'
      );
      return true;
    }
    const result = await shiftService.linkStaffByCode({
      lineUserId: event.source.userId,
      code: arg,
    });
    // 原因を追えるようにするが、LINE userId は残さない
    console.log(`[staff-link] source=user by=code ok=${result.ok}`);
    if (!result.ok) {
      await replyText(
        event,
        '連携コードを確認できませんでした。\n有効期限が切れている可能性があります。店長に再発行をご依頼ください。'
      );
      return true;
    }
    await replyText(event, linkedMessage(result.staff.name));
    return true;
  }

  /**
   * @returns {Promise<boolean>} 処理したら true（顧客向けの処理へは渡さない）
   */
  return async function handleStaffShift(event, text) {
    if (event.source?.type !== 'user' || !event.source.userId) return false;

    const link = parseLinkCommand(text);
    if (link) return handleLink(event, link);

    // 接頭辞なしで数字だけ送られた場合。発行済みのコードに一致したときだけ連携する。
    // 一致しなければ何も起きなかったものとして、以降の通常処理へそのまま進む
    const bare = parseBareCode(text);
    if (bare) {
      const result = await shiftService.linkStaffByCode({
        lineUserId: event.source.userId,
        code: bare,
      });
      console.log(`[staff-link] source=user by=bare-code ok=${result.ok}`);
      if (result.ok) {
        await replyText(event, linkedMessage(result.staff.name));
        return true;
      }
    }

    const staff = await shiftService.findStaffByLineUserId(event.source.userId);
    if (!staff) return false;

    // 内容確認への返事。申請の解釈より先に見る（「確定」を新しい申請と読ませないため）
    const answer = parseShiftAnswer(text);
    if (answer) return handleShiftAnswer(event, answer, staff);

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
    const lines = created.map((r) => `・${formatShift(r)}`).join('\n')
      + (replaced > 0 ? '\n（同じ日の申請は今回の内容で上書きしました）' : '');

    // ここではまだ確定させない。AI の読み違いをそのままシフト表に入れないため、
    // 必ず本人に内容を見せて確かめてもらう
    if (event.replyToken) {
      await lineClient.reply(event.replyToken, [confirmMessage({ staffName: staff.name, lines })]);
    }
    return true;
  };
}
