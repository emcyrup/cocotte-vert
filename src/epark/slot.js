// 予約から「EPARK 側で閉じる枠」を切り出す。
//
// 駆動部（ブラウザ操作）に渡す値をここで作る。日付・時刻は EPARK の画面に
// そのまま打ち込むものなので、**必ず JST で確定させる**。サーバーの TZ 設定に
// 引きずられると、1日ずれた枠を閉じるという最悪の間違いになる。

const parts = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

// 所要時間が入っていない予約（お泊まりなど）で使う既定の枠。
// 短すぎる枠を閉じて隣に予約が入るより、広めに閉じて後で開ける方が安全
export const DEFAULT_DURATION_MINUTES = 60;

/** JST の「YYYY-MM-DD」と「HH:MM」に割る */
function jstFields(date) {
  const got = Object.fromEntries(parts.formatToParts(date).map((p) => [p.type, p.value]));
  // hour12:false でも 24 時が返る環境があるため 0 時へ寄せる
  const hour = got.hour === '24' ? '00' : got.hour;
  return { date: `${got.year}-${got.month}-${got.day}`, time: `${hour}:${got.minute}` };
}

function addMinutes(time, minutes) {
  const [h, m] = time.split(':').map(Number);
  const total = h * 60 + m + minutes;
  // 日をまたぐ枠は「その日の終わり」で止める。翌日の枠まで閉じてしまわないため
  if (total >= 24 * 60) return '23:59';
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * 一覧の1行から、駆動部へ渡す枠を作る。
 * @returns {{reservationId:number, date:string, startTime:string, endTime:string, minutes:number}}
 */
export function slotOf(row) {
  const minutes = Number(row.duration_minutes) > 0
    ? Number(row.duration_minutes)
    : DEFAULT_DURATION_MINUTES;
  const { date, time } = jstFields(new Date(row.reserved_at));
  return {
    reservationId: Number(row.id),
    date,
    startTime: time,
    endTime: addMinutes(time, minutes),
    minutes,
  };
}

/** ログ・通知用の1行。顧客の氏名は入れない（内部 id でのみ参照する） */
export function slotLabel(slot) {
  return `res=${slot.reservationId} ${slot.date} ${slot.startTime}-${slot.endTime}`;
}
