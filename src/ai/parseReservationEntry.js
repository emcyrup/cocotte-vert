// スタッフが公式LINEへ自由記述で送る「予約登録」の解釈（Claude Haiku）。
//
// シフト申請の解釈（parseShiftRequest）と同じ方針で、迷ったときの安全側は
// 「読み取れなかった」。読み違えたまま予約を作ると、お客様の予定として残ってしまう。

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5';

const SYSTEM_PROMPT = [
  'あなたは店舗（ドッグサロン・ペットホテル）のスタッフが送る予約登録の文を、構造化データに変換する担当です。',
  '文から「お客様のお名前」「電話番号」「日付」「時刻」「コース」「担当者」を読み取り、JSON のみを返してください。',
  '',
  '規則:',
  '- 日付は必ず YYYY-MM-DD 形式。年の指定がなければ、今日以降でもっとも近い日付として解釈する。',
  '- 「明日」「あさって」「来週の月曜」などの相対表現は、指定された今日の日付を基準に解決する。',
  '- 時刻は必ず HH:MM（24時間制）。「14時」→ 14:00、「2時半」→ 14:30。',
  '  午前・午後の別が書かれておらず、営業時間から判断もできない場合は isRequest を false にする。',
  '- customerName は敬称（様・さん）を除いた氏名だけを入れる。わんちゃんの名前は入れない。',
  '- phone は書かれていればそのまま入れる。無ければ null。',
  '- menu はコース名（カット、シャンプー、トリミング、お泊まりなど）。書かれていなければ null。',
  '- staffName は担当者の名前。書かれていなければ null。',
  '- durationMinutes は「2時間」「90分」のように所要時間がはっきり書かれている場合だけ数値（分）で入れる。無ければ null。',
  '- お名前・日付・時刻のどれかが読み取れない場合は isRequest を false にする。',
  '- 予約と無関係な雑談、あいさつ、予約の取り消し・変更の依頼は isRequest を false にする。',
  '- 少しでも解釈に迷う場合は isRequest を false にすること。誤った予約を作る方が害が大きい。',
].join('\n');

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    isRequest: { type: 'boolean' },
    customerName: { type: ['string', 'null'] },
    phone: { type: ['string', 'null'] },
    date: { type: ['string', 'null'] },
    time: { type: ['string', 'null'] },
    menu: { type: ['string', 'null'] },
    staffName: { type: ['string', 'null'] },
    durationMinutes: { type: ['integer', 'null'] },
  },
  required: ['isRequest', 'customerName', 'phone', 'date', 'time', 'menu', 'staffName', 'durationMinutes'],
  additionalProperties: false,
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

// モデルの出力をそのまま信用せず、予約として成立する形かどうかをこちら側でも検証する
export function sanitizeEntry(parsed) {
  const none = { isRequest: false };
  if (!parsed?.isRequest) return none;

  const name = clean(parsed.customerName);
  const date = clean(parsed.date);
  const time = clean(parsed.time);
  if (!name || !DATE_RE.test(date ?? '') || !TIME_RE.test(time ?? '')) return none;
  // 存在しない日（2月30日など）を弾く。Date が繰り上げてしまうため日付で突き合わせる
  const check = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(check.getTime()) || check.toISOString().slice(0, 10) !== date) return none;

  const duration = parsed.durationMinutes;
  const validDuration =
    Number.isInteger(duration) && duration >= 1 && duration <= 1440 ? duration : null;

  return {
    isRequest: true,
    customerName: name,
    phone: clean(parsed.phone),
    date,
    time,
    menu: clean(parsed.menu),
    staffName: clean(parsed.staffName),
    durationMinutes: validDuration,
  };
}

export function createReservationEntryParser({ apiKey, fetchFn = fetch }) {
  /**
   * @param {string} p.text  「予約登録」を除いた本文
   * @param {string} p.today 今日の日付（JST・YYYY-MM-DD）。相対表現の基準にする
   */
  async function parse({ text, today }) {
    if (!apiKey) {
      console.warn('[resv-parse] ANTHROPIC_API_KEY 未設定のため解釈できません');
      return { isRequest: false };
    }
    try {
      const res = await fetchFn(API_URL, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 1024,
          system: `${SYSTEM_PROMPT}\n\n今日の日付（JST）: ${today}`,
          messages: [{ role: 'user', content: text }],
          output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        console.error(`[resv-parse] API エラー: HTTP ${res.status}`);
        return { isRequest: false };
      }
      const body = await res.json();
      if (body.stop_reason === 'refusal') return { isRequest: false };
      return sanitizeEntry(JSON.parse(body.content?.[0]?.text));
    } catch (err) {
      console.error(`[resv-parse] 解釈失敗: ${err.message}`);
      return { isRequest: false };
    }
  }

  return { parse };
}
