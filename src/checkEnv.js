// .env の設定状況を1画面で確かめるための組み立て。
//
// 判定と表示だけをここに置き、実際の問い合わせ（DB・LINE・SNS）は
// scripts/check-env.js が行う。テストできる形にしておきたいため分けてある。
//
// **秘密の値は絶対に出さない。** 「設定あり／未設定」と、問い合わせた結果だけを出す。
// 出力をそのまま貼って相談できることを前提にしている（トークンが混ざると貼れない）。

export const MARK = { ok: '✓', ng: '✗', warn: '!', off: '-' };

/** 設定されているかどうかだけを言う。値は返さない */
export const presence = (value) => (value ? '設定あり' : '未設定');

/**
 * 問い合わせ結果を1行にする。
 * @param {'ok'|'ng'|'warn'|'off'} level
 */
export const line = (level, label, detail) =>
  `  ${MARK[level]} ${label}: ${detail}`;

/**
 * 必須の設定。欠けているとアプリが起動しないもの。
 * config は loadConfig() の戻り値、checks は実際に問い合わせた結果。
 */
export function requiredRows(config, checks) {
  return [
    checks.db.ok
      ? line('ok', 'DATABASE_URL', `接続できました（${checks.db.detail}）`)
      : line('ng', 'DATABASE_URL', `接続できません: ${checks.db.detail}`),
    checks.line.ok
      ? line('ok', 'LINE アクセストークン', `有効（${checks.line.detail}）`)
      : line('ng', 'LINE アクセストークン', `確認できません: ${checks.line.detail}`),
    line(config.line.channelSecret ? 'ok' : 'ng', 'LINE チャネルシークレット',
      presence(config.line.channelSecret)),
  ];
}

/** 誤爆に直結する設定。ここが読めないまま運用すると事故になる */
export function sendModeRows(config) {
  const rows = [];
  if (config.sendMode === 'live') {
    rows.push(line('warn', 'SEND_MODE', 'live（本番送信。お客様へ実際に届きます）'));
  } else if (config.sendMode === 'test') {
    rows.push(line('ok', 'SEND_MODE', `test（${presence(config.testLineUserId)}の宛先へのみ送信）`));
  } else {
    rows.push(line('ok', 'SEND_MODE', 'dry_run（送信しません）'));
  }
  rows.push(line(config.staffNotifyChannel ? 'ok' : 'warn', 'スタッフ通知先',
    config.staffNotifyChannel));
  if (['slack', 'both'].includes(config.staffNotifyChannel)) {
    // Slack は叩くと実際に通知が飛ぶため、設定の有無だけを見る
    rows.push(line(config.slackWebhookUrl ? 'ok' : 'ng', 'Slack Webhook',
      `${presence(config.slackWebhookUrl)}（送信を伴うため疎通は確認しません）`));
  }
  if (['line', 'both'].includes(config.staffNotifyChannel)) {
    rows.push(line(config.staffLineGroupId ? 'ok' : 'warn', 'スタッフ用グループID',
      config.staffLineGroupId ? 'env で固定' : '未設定（Bot の招待時に自動設定されます）'));
  }
  return rows;
}

/** 外から見える URL。ここが違うと LIFF と画像取得が動かない */
export function urlRows(config) {
  const rows = [
    line(config.publicBaseUrl ? 'ok' : 'warn', 'PUBLIC_BASE_URL',
      config.publicBaseUrl ?? '未設定（SNS の画像取得とグループへの案内リンクが出せません）'),
    line('ok', '待ち受けポート', String(config.port)),
  ];
  const liff = [
    ['お客様の登録フォーム', config.liffUrl],
    ['お客様の予約フォーム', config.liffReserveUrl],
    ['スタッフ登録', config.liffStaffUrl],
    ['スタッフの予約登録フォーム', config.liffStaffReserveUrl],
  ];
  for (const [label, url] of liff) {
    rows.push(line(url ? 'ok' : 'ng', label, url ?? '未設定（LIFF_ID が要ります）'));
  }
  return rows;
}

/** 任意の連携。未設定でもアプリは動くので、落とさず状態だけ出す */
export function optionalRows(config, checks) {
  const rows = [];

  if (!config.anthropicApiKey) {
    rows.push(line('off', 'Claude API', '未設定（シフト・予約の読み取りと SNS 下書きが使えません）'));
  } else if (checks.anthropic.ok) {
    rows.push(line('ok', 'Claude API', '有効'));
  } else {
    rows.push(line('ng', 'Claude API', `確認できません: ${checks.anthropic.detail}`));
  }

  for (const [label, check, mode] of [
    ['Instagram', checks.instagram, config.igPostMode],
    ['Threads', checks.threads, config.threadsPostMode],
  ]) {
    if (check.skipped) rows.push(line('off', label, '未設定'));
    else if (check.ok) rows.push(line('ok', label, `${check.detail}（投稿モード: ${mode}）`));
    else rows.push(line('ng', label, `確認できません: ${check.detail}`));
  }

  // X と WordPress は署名・認証の形が違うため、ここでは設定の有無だけを見る
  const xReady = Boolean(config.x.apiKey && config.x.apiSecret
    && config.x.accessToken && config.x.accessSecret);
  rows.push(line(xReady ? 'ok' : 'off', 'X',
    xReady ? `4つとも設定あり（投稿モード: ${config.x.postMode}）` : '未設定'));

  const wpReady = Boolean(config.wordpress.baseUrl && config.wordpress.user
    && config.wordpress.appPassword);
  rows.push(line(wpReady ? 'ok' : 'off', 'WordPress',
    wpReady ? `設定あり（${config.wordpress.status} / 投稿モード: ${config.wordpress.postMode}）` : '未設定'));

  rows.push(line(config.adminUser && config.adminPassword ? 'ok' : 'warn', '管理画面の認証',
    config.adminUser && config.adminPassword ? '設定あり' : '未設定（管理画面は開けません）'));
  rows.push(line(config.ingestApiToken ? 'ok' : 'off', '取り込み API のトークン',
    presence(config.ingestApiToken)));

  return rows;
}

/** 配信の起点となる日数と店舗情報。既定値のままでも動くが、店舗ごとに変わる */
export function storeRows(config, store) {
  return [
    line('ok', '店舗名', store.name),
    line('ok', '営業時間', `${store.openTime}〜${store.closeTime}`),
    line('ok', '定休日', store.closedDayLabel),
    line('ok', '前々日確認', `${config.preReminderDaysBefore}日前`),
    line('ok', '来店フォロー', `${config.afterVisitDaysAfter}日後`),
    line('ok', '休眠フォロー', `${config.dormantDays}日で対象／1日 ${config.dormantDailyLimit}件まで`),
  ];
}

/** 直すべき点があるか。あれば終了コードを 1 にして、見落としを防ぐ */
export function hasProblem(rows) {
  return rows.some((r) => r.includes(` ${MARK.ng} `));
}

/**
 * .env に同じキーが2行以上あると、Node は**後に書いた方**を採る。
 * .env.example を写して上書きし損ねると、見本の値（user:pass など）が
 * 後ろに残って静かに勝つ。実際にこれで本番の接続が通らなかった。
 * @param {string} text .env の中身
 */
export function duplicateKeys(text) {
  const seen = new Map();
  for (const raw of String(text ?? '').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(raw);
    if (!m) continue;   // 空行・コメント・値の続きは飛ばす
    seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([key]) => key);
}

/** 重複があれば、後の行が採られることまで伝える */
export function duplicateRows(keys) {
  if (keys.length === 0) return [];
  return [
    line('ng', '.env の重複', `${keys.join(', ')} が2行以上あります`),
    '    → 同じキーが複数あると後の行が採られます。'
      + '.env.example を写したときの見本の行が残っていないか確認してください',
  ];
}
