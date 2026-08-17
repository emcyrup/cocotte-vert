// スタッフ用グループから「今日の予約」などと聞かれたときに一覧を返す。
//
// Push ではなく応答メッセージで返すので通数を消費しない。呼び出し側（staffCommand）が
// 「スタッフ通知先に設定済みのグループからの発言か」を確かめたうえで呼ぶ前提で、
// ここでは対象の絞り込みをしない。お客様の氏名を含む内容を第三者に見せないため、
// この前提は必ず守ること。
import { jstToday } from '../../util/jst.js';

// LINE のテキストは5000文字まで。1件あたり最大でも100文字強なので、
// 表示件数を絞れば上限には当たらない。多い日は件数だけ伝えて画面へ誘導する
const MAX_LINES = 30;

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

const STATUS_MARK = {
  requested: '※承認待ち',
  cancelled: '※キャンセル',
  no_show: '※無断キャンセル',
  visited: '（来店済）',
};

/** 「今日/明日/8月20日」などを JST の日付（YYYY-MM-DD）に直す。当たらなければ null */
export function parseReservationQuery(text, now = new Date()) {
  // スペースと句読点だけ落とす。日付の区切り（/ や -）は残す
  const t = text.replace(/[\s　]/g, '').replace(/[?？!！。、]/g, '');
  if (!/予約/.test(t)) return null;

  const today = jstToday(now);
  const shift = (days) => {
    // JST の日付だけを足し引きする。UTC 正午を基準にすれば夏時間も TZ も影響しない
    const base = new Date(Date.UTC(today.year, today.month - 1, today.day, 12));
    base.setUTCDate(base.getUTCDate() + days);
    return base.toISOString().slice(0, 10);
  };

  if (/^(今日|本日|きょう)の?予約(確認)?$/.test(t)) return { date: shift(0) };
  if (/^(明日|あした|あす)の?予約(確認)?$/.test(t)) return { date: shift(1) };
  if (/^(明後日|あさって)の?予約(確認)?$/.test(t)) return { date: shift(2) };
  // 「予約」「予約確認」だけなら今日として扱う（いちばん聞かれる形なので短く打てるように）
  if (/^予約(確認|一覧)?$/.test(t)) return { date: shift(0) };

  // 「8/20の予約」「8月20日の予約」「20日の予約」
  const md = t.match(/^(?:(\d{1,2})[/月])?(\d{1,2})日?の?予約(確認)?$/);
  if (!md) return null;

  const day = Number(md[2]);
  let month = md[1] ? Number(md[1]) : today.month;
  let year = today.year;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  if (md[1]) {
    // 月まで言われた場合。12月に「1/5の予約」と聞かれたら翌年、1月に「12/28」なら前年と、
    // 今日にいちばん近い年を選ぶ（過去も未来も聞かれうるため、前後どちらにも寄せる）
    if (month - today.month > 6) year -= 1;
    else if (today.month - month > 6) year += 1;
  } else if (day < today.day) {
    // 月を省略した「20日」が過ぎていれば来月とみなす（先の予定を聞く用途が大半のため）
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }

  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  // 2月30日のような存在しない日を弾く（Date が繰り上げてしまうため日付で突き合わせる）
  const check = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(check.getTime()) || check.getUTCDate() !== day) return null;
  return { date: iso };
}

function formatHeading(iso, count) {
  const d = new Date(`${iso}T12:00:00Z`);
  const label = `${d.getUTCMonth() + 1}月${d.getUTCDate()}日(${WEEKDAYS[d.getUTCDay()]})`;
  return count === 0 ? `${label} のご予約はありません。` : `${label} のご予約 ${count}件`;
}

function formatRow(r) {
  const time = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(r.reserved_at));
  const mark = STATUS_MARK[r.status] ? ` ${STATUS_MARK[r.status]}` : '';
  const detail = [r.menu || 'コース未定', r.staff_name || '担当未定'].join('／');
  return `${time} ${r.customer_name}様${mark}\n　${detail}`;
}

export function createReservationQuery({ pool }) {
  /**
   * @param {string} isoDate JST の日付（YYYY-MM-DD）
   * @returns {Promise<string>} グループへ返す本文
   */
  async function summarize(isoDate) {
    const { rows } = await pool.query(
      // 日付比較は JST で明示的に行う（TIMESTAMPTZ をそのまま比較すると9時間ずれる）
      `SELECT r.reserved_at, r.menu, r.status,
              c.name AS customer_name, s.name AS staff_name
         FROM reservations r
         JOIN customers c ON c.id = r.customer_id
         LEFT JOIN staff s ON s.id = r.staff_id
        WHERE (r.reserved_at AT TIME ZONE 'Asia/Tokyo')::date = $1::date
          -- 取消済みは枠を埋めないので出さない。承認待ちは対応が要るので出す
          AND r.status <> 'cancelled'
        ORDER BY r.reserved_at`,
      [isoDate]
    );

    const lines = [formatHeading(isoDate, rows.length)];
    if (rows.length === 0) return lines[0];

    lines.push('');
    rows.slice(0, MAX_LINES).forEach((r) => lines.push(formatRow(r)));
    if (rows.length > MAX_LINES) {
      lines.push('', `※ 残り${rows.length - MAX_LINES}件は管理画面でご確認ください。`);
    }
    const waiting = rows.filter((r) => r.status === 'requested').length;
    if (waiting > 0) {
      lines.push('', `承認待ちが${waiting}件あります。管理画面から承認してください。`);
    }
    return lines.join('\n');
  }

  return { summarize };
}
