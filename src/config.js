// 環境変数の読み込みと検証。
// 起動時に必須変数が欠けていたら即座に落とす（動き出してから気付くと誤爆リスクがあるため）。

const SEND_MODES = ['dry_run', 'test', 'live'];

// フェーズ進行に合わせて必須化する変数はここに追加していく
const REQUIRED_VARS = ['DATABASE_URL', 'LINE_CHANNEL_ACCESS_TOKEN', 'LINE_CHANNEL_SECRET'];

const STAFF_NOTIFY_CHANNELS = ['slack', 'line', 'both'];
const IG_POST_MODES = ['dry_run', 'live'];
// EPARK は「送信」ではなく相手の画面を書き換える操作なので、触らない状態（off）を既定に置く
const EPARK_MODES = ['off', 'dry_run', 'live'];

export function loadConfig(env = process.env) {
  const missing = REQUIRED_VARS.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new Error(`環境変数が未設定です: ${missing.join(', ')}`);
  }

  // 未指定なら必ず dry_run。live を既定値にできる経路を作らない
  const sendMode = env.SEND_MODE || 'dry_run';
  if (!SEND_MODES.includes(sendMode)) {
    throw new Error(
      `SEND_MODE が不正です: "${sendMode}"（${SEND_MODES.join(' | ')} のいずれか）`
    );
  }
  if (sendMode === 'test' && !env.TEST_LINE_USER_ID) {
    throw new Error('SEND_MODE=test には TEST_LINE_USER_ID が必要です');
  }

  // 日付比較を JST 前提で書いているため、TZ ずれは静かなバグになる。起動時に検知する
  if (env.TZ && env.TZ !== 'Asia/Tokyo') {
    throw new Error(`TZ は Asia/Tokyo を想定しています（現在: ${env.TZ}）`);
  }

  // スタッフ通知チャネル。使うチャネルに応じて必要な設定を起動時に検証する
  const staffNotifyChannel = env.STAFF_NOTIFY_CHANNEL || 'slack';
  if (!STAFF_NOTIFY_CHANNELS.includes(staffNotifyChannel)) {
    throw new Error(
      `STAFF_NOTIFY_CHANNEL が不正です: "${staffNotifyChannel}"（${STAFF_NOTIFY_CHANNELS.join(' | ')} のいずれか）`
    );
  }
  if (['slack', 'both'].includes(staffNotifyChannel) && !env.SLACK_WEBHOOK_URL) {
    throw new Error('STAFF_NOTIFY_CHANNEL に slack を含む場合は SLACK_WEBHOOK_URL が必要です');
  }
  // STAFF_LINE_GROUP_ID は任意（Bot のグループ参加時に DB へ自動設定される。env は手動上書き用）

  // Instagram 投稿も LINE と同じく、明示しない限り実投稿しない
  const igPostMode = env.IG_POST_MODE || 'dry_run';
  if (!IG_POST_MODES.includes(igPostMode)) {
    throw new Error(`IG_POST_MODE が不正です: "${igPostMode}"（${IG_POST_MODES.join(' | ')} のいずれか）`);
  }
  // Threads も同様（Instagram とは別アカウント・別トークンのため設定を分ける）
  const threadsPostMode = env.THREADS_POST_MODE || 'dry_run';
  if (!IG_POST_MODES.includes(threadsPostMode)) {
    throw new Error(
      `THREADS_POST_MODE が不正です: "${threadsPostMode}"（${IG_POST_MODES.join(' | ')} のいずれか）`
    );
  }
  // X / WordPress も LINE・Instagram と同じく、明示しない限り実投稿しない
  const xPostMode = env.X_POST_MODE || 'dry_run';
  if (!IG_POST_MODES.includes(xPostMode)) {
    throw new Error(`X_POST_MODE が不正です: "${xPostMode}"（${IG_POST_MODES.join(' | ')} のいずれか）`);
  }
  const wpPostMode = env.WP_POST_MODE || 'dry_run';
  if (!IG_POST_MODES.includes(wpPostMode)) {
    throw new Error(`WP_POST_MODE が不正です: "${wpPostMode}"（${IG_POST_MODES.join(' | ')} のいずれか）`);
  }
  // WordPress は記事なので、いきなり公開せず下書きに置く選択肢を持たせる
  const WP_STATUSES = ['draft', 'publish'];
  const wpStatus = env.WP_STATUS || 'draft';
  if (!WP_STATUSES.includes(wpStatus)) {
    throw new Error(`WP_STATUS が不正です: "${wpStatus}"（${WP_STATUSES.join(' | ')} のいずれか）`);
  }

  // EPARK 管理画面の自動操作。既定は off で、明示しない限り EPARK を一切触らない。
  // dry_run は「ログインして枠の状態を読むだけ」。駆動部の検証をここで済ませてから live へ移す
  const eparkMode = env.EPARK_MODE || 'off';
  if (!EPARK_MODES.includes(eparkMode)) {
    throw new Error(`EPARK_MODE が不正です: "${eparkMode}"（${EPARK_MODES.join(' | ')} のいずれか）`);
  }
  if (eparkMode !== 'off' && !(env.EPARK_USER && env.EPARK_PASSWORD)) {
    throw new Error(`EPARK_MODE=${eparkMode} には EPARK_USER / EPARK_PASSWORD が必要です`);
  }

  // 配信の起点となる日数。店舗によって「何日前に確認するか」が変わるため設定にする。
  // ジョブの SQL にはパラメータとして渡す（値を文字列で埋め込まない）
  const days = (key, fallback) => {
    const raw = env[key];
    if (raw == null || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 3650) {
      throw new Error(`${key} が不正です: "${raw}"（1〜3650 の整数）`);
    }
    return n;
  };
  const preReminderDaysBefore = days('PRE_REMINDER_DAYS_BEFORE', 2);
  const afterVisitDaysAfter = days('AFTER_VISIT_DAYS_AFTER', 7);
  const dormantDays = days('DORMANT_DAYS', 90);

  const liffId = env.LIFF_ID || null;

  return {
    databaseUrl: env.DATABASE_URL,
    line: {
      channelAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN,
      channelSecret: env.LINE_CHANNEL_SECRET,
    },
    liffId,
    // ID トークン検証の client_id はチャネル ID。LIFF ID の先頭部分と一致するため
    // 通常は導出で足りるが、異なる構成の場合は LIFF_CHANNEL_ID で明示できる
    liffChannelId: env.LIFF_CHANNEL_ID || (liffId ? liffId.split('-')[0] : null),
    liffUrl: liffId ? `https://liff.line.me/${liffId}` : null,
    // LIFF は URL 末尾にパスを足すとエンドポイント配下の別ページを開ける
    liffReserveUrl: liffId ? `https://liff.line.me/${liffId}/reserve.html` : null,
    // スタッフ用グループに置くボタンの遷移先（スタッフ登録の画面）
    liffStaffUrl: liffId ? `https://liff.line.me/${liffId}/staff.html` : null,
    // 「予約登録」と送られたときに返すボタンの遷移先（スタッフ用の予約登録フォーム）
    liffStaffReserveUrl: liffId ? `https://liff.line.me/${liffId}/staff-reserve.html` : null,
    slackWebhookUrl: env.SLACK_WEBHOOK_URL || null,
    staffNotifyChannel,
    staffLineGroupId: env.STAFF_LINE_GROUP_ID || null,
    anthropicApiKey: env.ANTHROPIC_API_KEY || null,
    // SNS キャプションの下書きに使うモデル。写真を見て文章を書く用途なので、
    // 分類（Haiku）より上のモデルを既定にしている。費用を抑えたい店舗は
    // claude-haiku-4-5 に落とせるよう設定で変えられるようにしてある
    captionModel: env.CAPTION_MODEL || 'claude-opus-5',
    sendMode,
    testLineUserId: env.TEST_LINE_USER_ID || null,
    dormantDailyLimit: Number(env.DORMANT_DAILY_LIMIT || 50),
    preReminderDaysBefore,
    afterVisitDaysAfter,
    dormantDays,
    birthdayCouponUrl: env.BIRTHDAY_COUPON_URL || null,
    // 未設定なら管理画面・取り込み API はそれぞれ無効（503）になる
    adminUser: env.ADMIN_USER || null,
    adminPassword: env.ADMIN_PASSWORD || null,
    ingestApiToken: env.INGEST_API_TOKEN || null,
    // 通数警告は上限の一定割合（既定10%）で判定する。割合ベースにしておけば
    // プラン変更のたびに設定を直さずに済む（ライト5,000通→500 / スタンダード30,000通→3,000）。
    // 通数で固定したい場合のみ QUOTA_WARN_REMAINING で明示する
    quotaWarnRatio: Number(env.QUOTA_WARN_RATIO || 0.1),
    quotaWarnRemaining: env.QUOTA_WARN_REMAINING ? Number(env.QUOTA_WARN_REMAINING) : null,
    // Instagram 投稿（未設定なら機能ごと無効）
    igUserId: env.IG_USER_ID || null,
    igAccessToken: env.IG_ACCESS_TOKEN || null,
    igPostMode,
    igGraphBase: env.IG_GRAPH_BASE || 'https://graph.instagram.com',
    // Threads 投稿（未設定なら機能ごと無効）
    threadsUserId: env.THREADS_USER_ID || null,
    threadsAccessToken: env.THREADS_ACCESS_TOKEN || null,
    threadsPostMode,
    threadsGraphBase: env.THREADS_GRAPH_BASE || 'https://graph.threads.net',
    // X 投稿（未設定なら投稿先の一覧に「未設定」として出る）。
    // X の書き込み API は有料プランが要る。4つ揃って初めて有効
    x: {
      apiKey: env.X_API_KEY || null,
      apiSecret: env.X_API_SECRET || null,
      accessToken: env.X_ACCESS_TOKEN || null,
      accessSecret: env.X_ACCESS_SECRET || null,
      postMode: xPostMode,
    },
    // WordPress 投稿。パスワードは「アプリケーションパスワード」を使う
    // （通常のログインパスワードは使わない）
    wordpress: {
      baseUrl: env.WP_BASE_URL || null,
      user: env.WP_USER || null,
      appPassword: env.WP_APP_PASSWORD || null,
      // 下書きで止めるか、そのまま公開するか
      status: wpStatus,
      postMode: wpPostMode,
    },
    // EPARK 管理画面の自動操作。ログイン情報は .env にのみ置き、ログにも画面にも出さない
    epark: {
      mode: eparkMode,
      user: env.EPARK_USER || null,
      password: env.EPARK_PASSWORD || null,
      // 管理画面のルート。URL に店舗の識別子が入るため、設定ファイルではなく .env に置き、
      // 設定ファイル側は {base} と書いておく（リポジトリは公開のため）
      baseUrl: env.EPARK_BASE_URL || null,
      // 押す場所は JSON で外に出す（相手の画面が変わってもコードを触らずに済ませる）
      profilePath: env.EPARK_PROFILE || 'config/epark-profile.json',
      // 本番にブラウザを置けない構成のための逃げ道。未指定なら playwright の既定
      browserPath: env.EPARK_BROWSER_PATH || null,
    },
    // Instagram は投稿画像を公開 URL から取得するため、外から見える自分の URL が要る
    publicBaseUrl: env.PUBLIC_BASE_URL || (env.DOMAIN ? `https://${env.DOMAIN}` : null),
    port: Number(env.PORT || 3000),
  };
}
