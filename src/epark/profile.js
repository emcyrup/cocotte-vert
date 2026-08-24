// EPARK 管理画面（受付管理）の「どこを押すか」を、コードではなく設定として持つ。
//
// 実物の画面に合わせてセレクタは変わる。決め打ちにすると相手の都合でデプロイが要るため、
// CSV の列の対応づけと同じく設定として外に出す。
//
// 実物から分かった作りに合わせてある:
//
//   * 受付表は「ライン」ごとの縦列（例: トリミング申込 / ホテル宿泊申込）
//   * 時間は固定の枠（実物は1時間刻み）。行は id="id_1000" のように HHMM
//   * 枠を閉じる＝その枠のチェックボックスを入れて「仮受付」を押す
//   * 枠を開け直す＝同じチェックボックスを入れて「キャンセル」を押す
//   * 日付の移動は URL ではなく JavaScript の呼び出し
//
// セレクタと手順に差し込める値:
//   {base}         EPARK_BASE_URL（管理画面のルート。設定ファイルに識別子を書かないため）
//   {date}         2026-09-01
//   {dateCompact}  20260901
//   {time}         10:00
//   {timeCompact}  1000
//   {line}         ライン ID（1 / 2 …）
//   {checkbox}     cell.checkbox を展開したセレクタ（手順の中で使える）
//   {closed} {open}  cell.closed / cell.open を展開したセレクタ。
//                  「押したあと、その枠が実際に変わるまで待つ」ために手順の waitFor で使う

const ACTIONS = ['click', 'fill', 'select', 'waitFor'];
const REQUIRED = ['loginUrl', 'login', 'day', 'lines', 'cell', 'close', 'open'];
const CELL_KEYS = ['checkbox', 'closed', 'open', 'ours'];

/** 差し込み。埋め込みは1か所にまとめ、駆動部で書式を散らさない */
export function fill(template, vars) {
  return String(template).replace(
    /\{(base|date|dateCompact|time|timeCompact|line|checkbox|closed|open)\}/g,
    (whole, key) => (vars[key] == null ? whole : vars[key])
  );
}

/**
 * コースの名前から、どのラインの枠を閉じるかを決める。
 * どれにも当てはまらなければ null（＝自動では触らず、チェックリストに残す）。
 * 取り違えて別のラインを閉じるより、人に回すほうが安い。
 */
export function lineFor(menu, lines) {
  const text = String(menu ?? '');
  for (const line of lines) {
    if ((line.match ?? []).some((word) => word && text.includes(word))) return line;
  }
  return lines.find((l) => l.fallback) ?? null;
}

function checkSteps(name, steps) {
  if (!Array.isArray(steps) || steps.length === 0) return `${name} の手順がありません`;
  for (const [i, step] of steps.entries()) {
    const used = ACTIONS.filter((a) => step?.[a]);
    if (used.length !== 1) return `${name}[${i}] は ${ACTIONS.join(' / ')} のどれか1つ`;
    if ((used[0] === 'fill' || used[0] === 'select') && step.value == null) {
      return `${name}[${i}] に value がありません`;
    }
  }
  return null;
}

/**
 * 設定として成り立っているか。
 * 壊れた設定のまま live に入ると、見当違いの枠を閉じかねないので起動前に弾く。
 * @returns {{ok: true} | {ok: false, error: string}}
 */
export function validateProfile(profile) {
  if (!profile || typeof profile !== 'object') return { ok: false, error: '設定がありません' };

  const missing = REQUIRED.filter((key) => !profile[key]);
  if (missing.length > 0) return { ok: false, error: `項目が足りません: ${missing.join(', ')}` };

  for (const key of ['user', 'password', 'submit']) {
    if (!profile.login[key]) return { ok: false, error: `login.${key} がありません` };
  }
  // ログインできたかを判断する手立てが要る。ready（入れた目印）か error（弾かれた目印）。
  // どちらも無いと、入れていない画面をそのまま操作しかねない
  if (!profile.login.ready && !profile.login.error) {
    return { ok: false, error: 'login.ready か login.error のどちらかが要ります' };
  }

  const { day } = profile;
  if (!day.url) return { ok: false, error: 'day.url がありません' };
  // 日付の移動は URL か JavaScript のどちらか。どちらも無いと毎回同じ日を開いてしまう
  const movesByDate =
    /\{date(Compact)?\}/.test(day.url) || /\{date(Compact)?\}/.test(day.script ?? '');
  if (!movesByDate) return { ok: false, error: 'day.url か day.script に {date} が要ります' };
  if (!day.ready) return { ok: false, error: 'day.ready がありません（開けたことを確かめられません）' };

  if (!Array.isArray(profile.lines) || profile.lines.length === 0) {
    return { ok: false, error: 'lines がありません' };
  }
  for (const [i, line] of profile.lines.entries()) {
    if (line.id == null || line.id === '') return { ok: false, error: `lines[${i}].id がありません` };
  }

  for (const key of CELL_KEYS) {
    if (!profile.cell[key]) return { ok: false, error: `cell.${key} がありません` };
    // 時刻とラインが入らないセレクタは、その日の枠を丸ごと掴んでしまう
    if (!String(profile.cell[key]).includes('{timeCompact}')) {
      return { ok: false, error: `cell.${key} に {timeCompact} が入っていません` };
    }
    if (!String(profile.cell[key]).includes('{line}')) {
      return { ok: false, error: `cell.${key} に {line} が入っていません` };
    }
  }

  for (const name of ['close', 'open']) {
    const error = checkSteps(name, profile[name]);
    if (error) return { ok: false, error };
  }

  const minutes = profile.slotMinutes ?? 60;
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 24 * 60) {
    return { ok: false, error: `slotMinutes が不正です: ${profile.slotMinutes}` };
  }
  return { ok: true };
}

/** 設定ファイルを読み、{base} を環境変数の値に展開する */
export async function loadProfile(path, readFile, base = null) {
  if (!path) return null;
  const text = await readFile(path, 'utf8');
  // 管理画面の URL には店舗の識別子が入る。設定ファイルには書かず .env から差し込む
  return JSON.parse(base ? text.replaceAll('{base}', base) : text);
}
