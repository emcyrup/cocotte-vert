// JST の「今日」を取得するヘルパー。
// サーバーの TZ 設定に依存させず、常に Asia/Tokyo で日付を確定させる。

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const dateTimeParts = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  month: 'numeric',
  day: 'numeric',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const dateParts = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  month: 'numeric',
  day: 'numeric',
  weekday: 'short',
});

/** 「7月28日(火) 20:00」形式（JST）。顧客向け・スタッフ向けの日時表記はこれに統一する */
export function formatJstDateTime(date) {
  const parts = Object.fromEntries(dateTimeParts.formatToParts(date).map((p) => [p.type, p.value]));
  return `${parts.month}月${parts.day}日(${parts.weekday}) ${parts.hour}:${parts.minute}`;
}

/**
 * 「7月28日(火)」形式（JST）。時刻が決まっていないもの（お泊まりの退室日など）に使う。
 * @param {string} iso YYYY-MM-DD
 */
export function formatJstDate(iso) {
  // 正午を基準にする。0 時だと UTC 換算で前日になり、日付が1日ずれる
  const parts = Object.fromEntries(
    dateParts.formatToParts(new Date(`${iso}T12:00:00+09:00`)).map((p) => [p.type, p.value])
  );
  return `${parts.month}月${parts.day}日(${parts.weekday})`;
}

export function jstToday(now = new Date()) {
  const iso = fmt.format(now); // "2026-07-26" 形式
  const [year, month, day] = iso.split('-').map(Number);
  return { year, month, day, iso };
}

export function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * 2/29 生まれを本日の対象に含めるか。
 * 平年には 2/29 が存在しないため、平年の 2/28 に前倒しで祝う。
 */
export function includeLeapDayBirthdays({ year, month, day }) {
  return month === 2 && day === 28 && !isLeapYear(year);
}
