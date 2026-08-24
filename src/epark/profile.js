// EPARK 管理画面の「どこを押すか」を、コードではなく設定として持つ。
//
// 実物の画面を見ないとセレクタは決まらない。CSV の列の対応づけと同じ理由で、
// 決め打ちにすると画面が変わるたびにデプロイが要る。相手の都合で変わるものは
// 外に出しておく（`docs/import-api.md` の「列の対応づけは画面から直す」と同じ方針）。
//
// 形:
//
//   {
//     loginUrl: 'https://.../login',
//     login: {
//       user: '#loginId', password: '#password', submit: 'button[type="submit"]',
//       ready: '.dashboard'            // ここが出たらログイン成功とみなす
//     },
//     dayUrl: 'https://.../schedule?date={date}',   // {date} は YYYY-MM-DD
//     slot: '[data-time="{time}"]',                 // {time} は HH:MM
//     closedWhen: '.is-closed',        // 枠がこの条件に当てはまれば「閉」
//     close: [ { click: '{slot}' }, { click: 'button:has-text("枠を閉じる")' } ],
//     open:  [ { click: '{slot}' }, { click: 'button:has-text("枠を開ける")' } ]
//   }
//
// close / open の1手は次のどれか。順に実行する。
//   { click: <selector> }              押す
//   { fill: <selector>, value: <str> } 入力する
//   { select: <selector>, value: <str> } 選ぶ
//   { waitFor: <selector> }            出るまで待つ（保存完了の合図など）
//
// selector には {slot} / {date} / {time} を埋め込める。

const ACTIONS = ['click', 'fill', 'select', 'waitFor'];

const REQUIRED = ['loginUrl', 'login', 'dayUrl', 'slot', 'closedWhen', 'close', 'open'];

/** 差し込む値。埋め込みは1か所にまとめ、駆動部で書式を散らさない */
export function fill(template, vars) {
  return String(template).replace(/\{(slot|date|time)\}/g, (whole, key) =>
    vars[key] == null ? whole : vars[key]
  );
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

  for (const key of ['user', 'password', 'submit', 'ready']) {
    if (!profile.login[key]) return { ok: false, error: `login.${key} がありません` };
  }
  if (!String(profile.dayUrl).includes('{date}')) {
    return { ok: false, error: 'dayUrl に {date} が入っていません' };
  }
  if (!String(profile.slot).includes('{time}')) {
    // 時刻が入らないと、その日の全部の枠を閉じてしまう
    return { ok: false, error: 'slot に {time} が入っていません' };
  }

  for (const name of ['close', 'open']) {
    const steps = profile[name];
    if (!Array.isArray(steps) || steps.length === 0) {
      return { ok: false, error: `${name} の手順がありません` };
    }
    for (const [i, step] of steps.entries()) {
      const used = ACTIONS.filter((a) => step?.[a]);
      if (used.length !== 1) {
        return { ok: false, error: `${name}[${i}] は ${ACTIONS.join(' / ')} のどれか1つ` };
      }
      if ((used[0] === 'fill' || used[0] === 'select') && step.value == null) {
        return { ok: false, error: `${name}[${i}] に value がありません` };
      }
    }
  }
  return { ok: true };
}

/** 設定ファイルを読む。無ければ null（EPARK_MODE=off のままで動かすため） */
export async function loadProfile(path, readFile) {
  if (!path) return null;
  const text = await readFile(path, 'utf8');
  return JSON.parse(text);
}
