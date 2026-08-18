// お泊まり（宿泊）の表記。
//
// 予約そのものは「入室の日時」で持ち、退室日は別に持つ（reservation_drafts.checkout_date）。
// 泊数はその差から導く。確認メッセージにも予約のメモにも同じ言い方で出したいため、
// 組み立てはここに1つだけ置く。

import { formatJstDate } from '../util/jst.js';

const DAY_MS = 86400000;

/** 入室日と退室日から泊数を出す。宿泊でなければ null */
export function nightsOf({ reservedAt, checkoutDate }) {
  if (!checkoutDate) return null;
  const checkIn = new Date(reservedAt);
  if (Number.isNaN(checkIn.getTime())) return null;
  // 入室日も JST の日付に直してから引く。時刻が入ったままだと日数が1つずれる
  const inDate = new Date(checkIn.getTime() + 9 * 3600000).toISOString().slice(0, 10);
  const nights = Math.round(
    (new Date(`${checkoutDate}T12:00:00Z`) - new Date(`${inDate}T12:00:00Z`)) / DAY_MS
  );
  return nights >= 1 ? nights : null;
}

/** 「2泊（8月22日(土) 退室予定）」。宿泊でなければ null */
export function stayLabel({ reservedAt, checkoutDate }) {
  const nights = nightsOf({ reservedAt, checkoutDate });
  if (!nights) return null;
  return `${nights}泊（${formatJstDate(checkoutDate)} 退室予定）`;
}
