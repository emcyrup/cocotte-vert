// スタッフが公式LINE から予約を入れる。
//
// 「予約登録」で始まる発言だけを対象にする。接頭辞を必須にしているのは、普段の会話や
// お客様の発言を予約として読み取ってしまわないため。
//
// 送られた文章は AI が読み取っているため、その場では登録しない。読み取った内容を
// 復唱し、［登録］が押されたときだけ本予約にする（シフト変更の確定と同じ考え方）。
//
// 使える場所は2つ。呼び出し側がどちらかを確かめてから渡す前提で、ここでは判定しない。
//   - スタッフ用グループ（staffCommand から）
//   - 連携済みスタッフとの 1:1 トーク（staffShift から）

import { formatJstDateTime, jstToday } from '../../util/jst.js';
import { stayLabel } from '../../reservations/stay.js';

// 「予約確認」（一覧の問い合わせ）と紛れないよう、登録は別の言い方に寄せる
const ENTRY_PREFIX = /^(?:予約(?:登録|追加|入力)|新規予約)[\s　:：,、]*/;

const HOW_TO_WRITE =
  '飼い主様のお名前・日付・時刻を入れて、1件ずつ送ってください。\n' +
  '例：予約登録 8/20 14時 田中花子 カット 担当佐藤\n' +
  '　　予約登録 明日10:00 山田 090-1234-5678 シャンプー\n' +
  '　　予約登録 8/20 14時 田中花子 お泊まり 2泊\n' +
  '※お名前はわんちゃんではなく飼い主様のお名前でお願いします。';

// 読み取れなかった理由が分かるときは、書き方の案内より先に何を直せばよいかを伝える
const REASON_TEXT = {
  multiple: '1通に予約が複数あるようです。取り違えを防ぐため、1件ずつ送ってください。',
  pet_only: 'わんちゃんのお名前しか読み取れませんでした。飼い主様のお名前で送ってください。',
};

/**
 * 「予約登録 …」なら、接頭辞を除いた本文を返す。そうでなければ null。
 * 本文が空でも空文字を返す（書き方を案内するため、無言で落とさない）。
 */
export function parseEntryCommand(text) {
  const t = String(text ?? '').replace(/^[\s　]+/, '');
  if (!ENTRY_PREFIX.test(t)) return null;
  return t.replace(ENTRY_PREFIX, '').trim();
}

const detailRow = (label, value) => ({
  type: 'box',
  layout: 'baseline',
  contents: [
    { type: 'text', text: label, size: 'sm', color: '#888888', flex: 2 },
    { type: 'text', text: value, size: 'sm', wrap: true, flex: 5 },
  ],
});

/** 読み取った内容の復唱と［登録］［やめる］ */
export function confirmMessage({ draft, customerLabel }) {
  const details = [
    detailRow('お客様', customerLabel),
    detailRow('日時', formatJstDateTime(new Date(draft.reserved_at))),
    detailRow('コース', draft.menu || '未定'),
    detailRow('担当', draft.staff_name || '未定'),
  ];
  const stay = stayLabel({ reservedAt: draft.reserved_at, checkoutDate: draft.checkout_date });
  if (stay) details.push(detailRow('お泊まり', stay));
  if (draft.duration_minutes) details.push(detailRow('所要', `${draft.duration_minutes}分`));

  // 新規で作ると、わんちゃんの名前を入れてしまったときに別のお客様が増える。ここで気付いてもらう
  if (!draft.customer_id && draft.new_customer_name) {
    details.push({
      type: 'text',
      text: `「${draft.new_customer_name}様」は新しいお客様として登録されます。`
        + '飼い主様のお名前かどうかご確認ください。',
      size: 'xs', color: '#c2410c', wrap: true, margin: 'sm',
    });
  }

  return {
    type: 'flex',
    altText: '予約の内容確認',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'md',
        contents: [
          { type: 'text', text: 'この内容で登録しますか？', weight: 'bold', size: 'md' },
          { type: 'box', layout: 'vertical', spacing: 'sm', contents: details },
          {
            type: 'text',
            text: '［登録］を押すと予約カレンダーに入り、前々日の確認メッセージの対象になります。',
            size: 'xs', color: '#888888', wrap: true, margin: 'md',
          },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          {
            type: 'button', style: 'primary',
            action: { type: 'postback', label: '登録', data: `action=resv&v=ok&d=${draft.id}`, displayText: '登録' },
          },
          {
            type: 'button', style: 'link', height: 'sm',
            action: { type: 'postback', label: 'やめる', data: `action=resv&v=no&d=${draft.id}`, displayText: 'やめる' },
          },
        ],
      },
    },
  };
}

/** 同名の候補が複数いるときに、どの方かを選んでもらう */
export function pickerMessage({ draftId, name, candidates }) {
  const buttons = candidates.map((c) => ({
    type: 'button', style: 'secondary', height: 'sm',
    action: {
      type: 'postback',
      // 電話番号の下4桁を添えて見分けられるようにする（全桁は出さない）
      label: c.phone_norm ? `${c.name}（下4桁 ${c.phone_norm.slice(-4)}）` : `${c.name}（電話未登録）`,
      data: `action=resv&v=pick&d=${draftId}&c=${c.id}`,
      displayText: c.name,
    },
  }));
  buttons.push({
    type: 'button', style: 'link', height: 'sm',
    action: {
      type: 'postback', label: '新しいお客様として登録',
      data: `action=resv&v=new&d=${draftId}`, displayText: '新しいお客様として登録',
    },
  });

  return {
    type: 'flex',
    altText: 'どちらのお客様ですか？',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'md',
        contents: [
          { type: 'text', text: 'どちらのお客様ですか？', weight: 'bold', size: 'md' },
          { type: 'text', text: `「${name}」に当てはまる方が複数います。`, size: 'sm', wrap: true },
        ],
      },
      footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: buttons },
    },
  };
}

/** 予約が入ったことを伝える本文 */
export function registeredText({ draft, customerLabel, createdCustomer }) {
  const lines = [
    '予約を登録しました。',
    `${customerLabel}　${formatJstDateTime(new Date(draft.reserved_at))}`,
    `${draft.menu || 'コース未定'}／${draft.staff_name || '担当未定'}`,
  ];
  const stay = stayLabel({ reservedAt: draft.reserved_at, checkoutDate: draft.checkout_date });
  if (stay) lines.push(`お泊まり ${stay}`);
  if (createdCustomer) {
    // 電話番号が無いとリマインド配信の突合ができないため、後で足してもらう
    lines.push('', '新しいお客様として登録しました。お電話番号などは店舗管理画面から追加してください。');
  }
  // LINE から直せるのは「入れる」ところまで。直し方が分からず入れ直されると二重になる
  lines.push('', '内容の変更・取消は店舗管理画面から行ってください。');
  return lines.join('\n');
}

export function createReservationEntry({ drafts, entryParser, lineClient, slack, now = () => new Date() }) {
  async function replyText(event, text) {
    if (event.replyToken) {
      await lineClient.reply(event.replyToken, [{ type: 'text', text }]);
    }
  }

  async function replyMessage(event, message) {
    if (event.replyToken) {
      await lineClient.reply(event.replyToken, [message]);
    }
  }

  /** 発言の出どころ。下書きはここでしか動かせない */
  function sourceOf(event) {
    const s = event.source ?? {};
    if (s.type === 'group' && s.groupId) return { type: 'group', id: s.groupId };
    if (s.type === 'user' && s.userId) return { type: 'user', id: s.userId };
    return null;
  }

  const labelOf = (draft) =>
    draft.customer_name
      ? `${draft.customer_name}様`
      : `${draft.new_customer_name}様（新規）`;

  /**
   * 「予約登録 …」の本文を解釈して、下書きと確認メッセージを返す。
   * @returns {Promise<boolean>} 処理したら true
   */
  async function handle(event, body) {
    const source = sourceOf(event);
    if (!source) return false;

    if (!body) {
      await replyText(event, `予約の登録ですね。\n${HOW_TO_WRITE}`);
      return true;
    }

    const entry = await entryParser.parse({ text: body, today: jstToday(now()).iso });
    if (!entry.isRequest) {
      const head = REASON_TEXT[entry.reason] ?? '予約として読み取れませんでした。';
      await replyText(event, `${head}\n${HOW_TO_WRITE}`);
      return true;
    }

    const [{ matches, by, phoneNorm }, staff] = await Promise.all([
      drafts.findCustomers({ name: entry.customerName, phone: entry.phone }),
      drafts.findStaffByName(entry.staffName),
    ]);

    // 該当者が1人に絞れないときは、下書きだけ先に作って選んでもらう。
    // 新規として登録する道も残すため、名前と電話番号は下書きに持たせておく
    const single = matches.length === 1 ? matches[0] : null;
    const draftId = await drafts.create({
      source,
      entry: { ...entry, rawText: body },
      customerId: single?.id ?? null,
      newCustomer: single ? null : { name: entry.customerName, phone: phoneNorm },
      staffId: staff?.id ?? null,
    });
    console.log(
      `[resv-entry] source=${source.type} draft=${draftId} match=${by} candidates=${matches.length}`
    );

    if (matches.length > 1) {
      await replyMessage(
        event,
        pickerMessage({ draftId, name: entry.customerName, candidates: matches })
      );
      return true;
    }

    const draft = await drafts.get({ draftId, source });
    await replyMessage(event, confirmMessage({ draft, customerLabel: labelOf(draft) }));
    return true;
  }

  // 値が無いと Number(null) が 0 になり、そのまま id として通ってしまう。必ずここを通す
  const idParam = (params, key) => {
    const raw = params.get(key);
    const n = raw == null ? NaN : Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  };

  /** ［登録］［やめる］［どちらのお客様か］のボタン */
  async function decide(event, params) {
    const source = sourceOf(event);
    const draftId = idParam(params, 'd');
    if (!source || draftId === null) return;

    const answer = params.get('v');
    if (answer === 'pick' || answer === 'new') {
      const customerId = answer === 'pick' ? idParam(params, 'c') : null;
      if (answer === 'pick' && customerId === null) return;
      const picked = customerId !== null
        ? await drafts.pickCustomer({ draftId, source, customerId })
        : { ok: true, draft: await drafts.get({ draftId, source }) };
      if (!picked.ok || !picked.draft || picked.draft.status !== 'pending') {
        await replyText(event, 'この予約の下書きは見つかりませんでした。もう一度お送りください。');
        return;
      }
      await replyMessage(
        event,
        confirmMessage({ draft: picked.draft, customerLabel: labelOf(picked.draft) })
      );
      return;
    }

    if (answer === 'no') {
      const result = await drafts.cancel({ draftId, source });
      await replyText(
        event,
        result.ok
          ? '予約の登録をやめました。入れ直す場合は、もう一度お送りください。'
          : 'この予約の下書きは見つかりませんでした。'
      );
      return;
    }

    if (answer !== 'ok') return;

    let result;
    try {
      result = await drafts.register({ draftId, source });
    } catch (err) {
      // 登録に失敗したことを本人に伝えないと、入っていない予約を入ったつもりで運用してしまう
      await slack.notifyError(`LINE からの予約登録に失敗（draft=${draftId}）`, err);
      await replyText(event, '予約の登録に失敗しました。お手数ですが店舗管理画面から入れてください。');
      return;
    }

    if (!result.ok) {
      const messages = {
        not_found: 'この予約の下書きは見つかりませんでした。もう一度お送りください。',
        already_decided: 'この予約はすでに登録済み、または取りやめ済みです。',
        expired: '時間が経ちすぎたため登録できません。お手数ですが、もう一度お送りください。',
        customer_unresolved: 'お客様が特定できていません。もう一度お送りください。',
      };
      await replyText(event, messages[result.error] ?? '予約を登録できませんでした。');
      return;
    }

    console.log(`[resv-entry] registered draft=${draftId} reservation=${result.reservationId}`);
    await replyText(
      event,
      registeredText({
        draft: result.draft,
        customerLabel: result.draft.customer_name
          ? `${result.draft.customer_name}様`
          : `${result.draft.new_customer_name}様`,
        createdCustomer: result.createdCustomer,
      })
    );
  }

  return { handle, decide };
}
