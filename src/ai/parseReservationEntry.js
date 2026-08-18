// スタッフが公式LINEへ自由記述で送る「予約登録」の解釈（Claude Haiku）。
//
// シフト申請の解釈（parseShiftRequest）と同じ方針で、迷ったときの安全側は
// 「読み取れなかった」。読み違えたまま予約を作ると、お客様の予定として残ってしまう。

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5';

// お泊まりの上限。これを超える泊数は書き間違いとみなし、読み取らない
const MAX_NIGHTS = 30;

const SYSTEM_PROMPT = [
  'あなたは店舗（ドッグサロン・ペットホテル）のスタッフが送る予約登録の文を、構造化データに変換する担当です。',
  '文から「飼い主様のお名前」「電話番号」「日付」「時刻」「コース」「担当者」「お泊まりの泊数」を読み取り、JSON のみを返してください。',
  '',
  '規則:',
  '- 日付は必ず YYYY-MM-DD 形式。年の指定がなければ、今日以降でもっとも近い日付として解釈する。',
  '- 「明日」「あさって」「来週の月曜」などの相対表現は、指定された今日の日付を基準に解決する。',
  '- 時刻は必ず HH:MM（24時間制）。「14時」→ 14:00、「2時半」→ 14:30。',
  '  午前・午後の別が書かれていない場合は、営業時間に収まる方に解釈する。',
  '  営業時間に収まる解釈が2つある、または1つも無い場合は isRequest を false にする。',
  '- customerName には飼い主様（人）のお名前だけを、敬称（様・さん）を除いて入れる。',
  '- わんちゃんの名前は customerName に入れず、petName に入れる。',
  '  「ココちゃん」「トイプードルのマロン」のように、人のお名前が書かれておらず',
  '  わんちゃんの名前しか無い場合は、customerName を null にし isRequest を false にする。',
  '- phone は書かれていればそのまま入れる。無ければ null。',
  '- menu はコース名（カット、シャンプー、トリミング、お泊まりなど）。書かれていなければ null。',
  '- staffName は担当者の名前。書かれていなければ null。',
  '- durationMinutes は「2時間」「90分」のように当日中の所要時間がはっきり書かれている場合だけ数値（分）で入れる。無ければ null。',
  '- お泊まり（宿泊）の予約では、date と time にお預かり（入室）の日時を入れる。',
  '  nights に泊数を入れる。「2泊」→ 2、「3日間お預かり」→ 2（最終日は退室日のため泊数は1つ少ない）。',
  '  退室日が書かれていれば checkoutDate に YYYY-MM-DD で入れる。書かれていなければ null。',
  '  泊数も退室日も書かれていない日帰りの予約では、どちらも null にする。',
  '- entryCount には、その文に書かれている予約の件数を入れる。1件だけなら 1。',
  '  2件以上書かれている場合は、1件目の内容を入れたうえで entryCount にその件数を入れる。',
  '- お名前・日付・時刻のどれかが読み取れない場合は isRequest を false にする。',
  '- 予約と無関係な雑談、あいさつ、予約の取り消し・変更の依頼は isRequest を false にする。',
  '- 少しでも解釈に迷う場合は isRequest を false にすること。誤った予約を作る方が害が大きい。',
].join('\n');

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    isRequest: { type: 'boolean' },
    customerName: { type: ['string', 'null'] },
    petName: { type: ['string', 'null'] },
    phone: { type: ['string', 'null'] },
    date: { type: ['string', 'null'] },
    time: { type: ['string', 'null'] },
    menu: { type: ['string', 'null'] },
    staffName: { type: ['string', 'null'] },
    durationMinutes: { type: ['integer', 'null'] },
    nights: { type: ['integer', 'null'] },
    checkoutDate: { type: ['string', 'null'] },
    entryCount: { type: ['integer', 'null'] },
  },
  required: [
    'isRequest', 'customerName', 'petName', 'phone', 'date', 'time', 'menu', 'staffName',
    'durationMinutes', 'nights', 'checkoutDate', 'entryCount',
  ],
  additionalProperties: false,
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const clean = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

// 存在しない日（2月30日など）を弾く。Date が繰り上げてしまうため日付で突き合わせる
function realDate(iso) {
  if (!DATE_RE.test(iso ?? '')) return null;
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) return null;
  return d;
}

const addDays = (iso, days) =>
  new Date(new Date(`${iso}T12:00:00Z`).getTime() + days * 86400000).toISOString().slice(0, 10);

/**
 * お泊まりの泊数と退室日。どちらか一方しか書かれていなくても、もう一方を導いて揃える。
 * 食い違うときは退室日を優先する（日付の方が読み違いに気付きやすいため）。
 */
function stayOf(date, parsed) {
  const nights = Number.isInteger(parsed?.nights) && parsed.nights >= 1 ? parsed.nights : null;
  let checkout = realDate(clean(parsed?.checkoutDate)) ? clean(parsed.checkoutDate) : null;
  if (!checkout && nights) checkout = addDays(date, nights);
  if (!checkout) return { nights: null, checkoutDate: null };

  const span = Math.round(
    (new Date(`${checkout}T12:00:00Z`) - new Date(`${date}T12:00:00Z`)) / 86400000
  );
  // 退室日が入室日以前、または長すぎるものは読み違い。宿泊なしとして扱う
  if (span < 1 || span > MAX_NIGHTS) return { nights: null, checkoutDate: null };
  return { nights: span, checkoutDate: checkout };
}

// モデルの出力をそのまま信用せず、予約として成立する形かどうかをこちら側でも検証する
export function sanitizeEntry(parsed) {
  const none = { isRequest: false };
  if (!parsed) return none;

  // 1通に複数件あると、書かれていない分が黙って落ちる。読み取らず書き直してもらう
  if (Number.isInteger(parsed.entryCount) && parsed.entryCount > 1) {
    return { isRequest: false, reason: 'multiple' };
  }

  const name = clean(parsed.customerName);
  // わんちゃんの名前で登録すると、その名前の飼い主様が新しく作られてしまう
  if (!name && clean(parsed.petName)) return { isRequest: false, reason: 'pet_only' };
  if (!parsed.isRequest || !name) return none;

  const date = clean(parsed.date);
  const time = clean(parsed.time);
  if (!realDate(date) || !TIME_RE.test(time ?? '')) return none;

  const duration = parsed.durationMinutes;
  const validDuration =
    Number.isInteger(duration) && duration >= 1 && duration <= 1440 ? duration : null;
  const stay = stayOf(date, parsed);

  return {
    isRequest: true,
    customerName: name,
    phone: clean(parsed.phone),
    date,
    time,
    menu: clean(parsed.menu),
    staffName: clean(parsed.staffName),
    durationMinutes: validDuration,
    nights: stay.nights,
    checkoutDate: stay.checkoutDate,
  };
}

export function createReservationEntryParser({ apiKey, store = null, fetchFn = fetch }) {
  // 「2時」を 14:00 と決めるには営業時間が要る。プロンプトに書いておく
  const hours = store?.openTime && store?.closeTime
    ? `\n営業時間（JST）: ${store.openTime}〜${store.closeTime}`
    : '';

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
          system: `${SYSTEM_PROMPT}\n\n今日の日付（JST）: ${today}${hours}`,
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
