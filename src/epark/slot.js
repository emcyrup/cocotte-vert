// 予約から「EPARK 側で閉じる枠」を切り出す。
//
// 相手の受付表は**固定の時間枠**（実物は1時間刻み）で、こちらの予約は所要時間がまちまち。
// 90分の予約なら10:00と11:00の2枠を閉じる、というように**またがる枠を全部**返す。
// 1枠しか閉じないと、はみ出した時間に別のお客様が入れてしまう。
//
// 日付・時刻は EPARK の画面にそのまま打ち込むものなので、**必ず JST で確定させる**。
// サーバーの TZ 設定に引きずられると、1日ずれた枠を閉じるという最悪の間違いになる。

const parts = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

// 所要時間が入っていない予約（お泊まりなど）で使う既定の長さ。
// 短すぎる枠を閉じて隣に予約が入るより、広めに閉じて後で開けるほうが安全
export const DEFAULT_DURATION_MINUTES = 60;

// 1日ぶんより長い予約（お泊まり）でも、閉じるのはその日の枠まで。
// 泊数ぶんの枠を勝手に触りに行かない（初日の受付枠だけを押さえる）
const MAX_CELLS = 24;

/** JST の「YYYY-MM-DD」と「HH:MM」に割る */
function jstFields(date) {
  const got = Object.fromEntries(parts.formatToParts(date).map((p) => [p.type, p.value]));
  // hour12:false でも 24 時が返る環境があるため 0 時へ寄せる
  const hour = got.hour === '24' ? '00' : got.hour;
  return { date: `${got.year}-${got.month}-${got.day}`, time: `${hour}:${got.minute}` };
}

const toMinutes = (time) => {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
};

const toTime = (minutes) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/**
 * またがる枠の開始時刻を並べる。枠は 00:00 からの等間隔として扱う
 * （実物の受付表は10:00始まりだが、行が無い時刻は駆動部が「枠なし」として弾く）。
 */
export function cellTimes(startTime, minutes, slotMinutes) {
  const start = Math.floor(toMinutes(startTime) / slotMinutes) * slotMinutes;
  const end = toMinutes(startTime) + minutes;
  const times = [];
  for (let at = start; at < end && times.length < MAX_CELLS; at += slotMinutes) {
    // 日をまたぐぶんは翌日の枠になる。その日の枠だけを閉じる
    if (at >= 24 * 60) break;
    times.push(toTime(at));
  }
  return times;
}

/**
 * 一覧の1行から、駆動部へ渡す枠を作る。
 * @returns {{reservationId:number, date:string, dateCompact:string, startTime:string,
 *            endTime:string, minutes:number, menu:string, cells:string[]}}
 */
export function slotOf(row, { slotMinutes = 60 } = {}) {
  const minutes = Number(row.duration_minutes) > 0
    ? Number(row.duration_minutes)
    : DEFAULT_DURATION_MINUTES;
  const { date, time } = jstFields(new Date(row.reserved_at));
  const endMinutes = Math.min(toMinutes(time) + minutes, 24 * 60 - 1);
  return {
    reservationId: Number(row.id),
    date,
    dateCompact: date.replaceAll('-', ''),
    startTime: time,
    endTime: toTime(endMinutes),
    minutes,
    menu: row.menu ?? '',
    cells: cellTimes(time, minutes, slotMinutes),
  };
}

/** ログ・通知用の1行。顧客の氏名は入れない（内部 id でのみ参照する） */
export function slotLabel(slot) {
  return `res=${slot.reservationId} ${slot.date} ${slot.startTime}-${slot.endTime}`;
}
