// 環境変数の読み込みと検証。
// 起動時に必須変数が欠けていたら即座に落とす（動き出してから気付くと誤爆リスクがあるため）。

const SEND_MODES = ['dry_run', 'test', 'live'];

// フェーズ進行に合わせて必須化する変数はここに追加していく
const REQUIRED_VARS = [
  'DATABASE_URL',
  'LINE_CHANNEL_ACCESS_TOKEN',
  'LINE_CHANNEL_SECRET',
  'SLACK_WEBHOOK_URL',
];

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

  return {
    databaseUrl: env.DATABASE_URL,
    line: {
      channelAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN,
      channelSecret: env.LINE_CHANNEL_SECRET,
    },
    liffId: env.LIFF_ID || null,
    slackWebhookUrl: env.SLACK_WEBHOOK_URL,
    anthropicApiKey: env.ANTHROPIC_API_KEY || null,
    sendMode,
    testLineUserId: env.TEST_LINE_USER_ID || null,
    dormantDailyLimit: Number(env.DORMANT_DAILY_LIMIT || 50),
    port: Number(env.PORT || 3000),
  };
}
