// EPARK 側の枠を閉じる／開け直す作業を1回流す。
//
// 作業の一覧を取る先を2通り選べる。ブラウザとデータベースの両方に届く場所が
// 無いための造り（GitHub Actions はブラウザだけ、アプリサーバーはDBだけ）。
//
//   node scripts/run-epark-sync.js                 # データベースから直に読む
//   node scripts/run-epark-sync.js --via=api       # 管理 API 越しに読む（Actions 用）
//   node scripts/run-epark-sync.js --dry-run       # 読むだけに落として実行
//
// --dry-run は安全側への上書きだけを許す（live へ上げる指定は用意しない）。
// live にするときは実行時に EPARK_MODE=live を明示的に渡すこと。
//
// --via=api で使う設定:
//   ADMIN_BASE_URL … 管理画面の URL（https://…）
//   ADMIN_USER / ADMIN_PASSWORD … 管理画面の Basic 認証

if (process.argv.includes('--dry-run')) {
  process.env.EPARK_MODE = 'dry_run';
}
const viaApi = process.argv.includes('--via=api');

// EPARK_MODE を確定させてから読み込む（config はロード時に環境変数を固定するため動的 import）
const { loadConfig } = await import('../src/config.js');
const { createSlackNotifier } = await import('../src/notify/slack.js');
const { createEparkSync } = await import('../src/epark/sync.js');
const { createNullDriver } = await import('../src/epark/driver.js');
const { createBrowserDriver } = await import('../src/epark/browserDriver.js');
const { loadProfile } = await import('../src/epark/profile.js');
const { readFile } = await import('node:fs/promises');

const config = loadConfig();

// Slack が未設定でも止めない。Actions から流すときは通知先が無いこともある
const slack = config.slackWebhookUrl
  ? createSlackNotifier({ webhookUrl: config.slackWebhookUrl })
  : {
      notify: async (text) => console.log(text),
      notifyError: async (context, err) => console.error(`${context}: ${err.message}`),
    };

let pool = null;
let externalBlocks;
if (viaApi) {
  const { createHttpBlocks } = await import('../src/epark/httpBlocks.js');
  const baseUrl = process.env.ADMIN_BASE_URL;
  if (!baseUrl) {
    console.error('--via=api には ADMIN_BASE_URL が要ります（管理画面の URL）');
    process.exit(1);
  }
  externalBlocks = createHttpBlocks({
    baseUrl,
    user: config.adminUser,
    password: config.adminPassword,
  });
  console.log(`作業の一覧は管理 API から取ります（${baseUrl}）`);
} else {
  const { createExternalBlocks } = await import('../src/reservations/externalBlock.js');
  ({ pool } = await import('../src/db/pool.js'));
  externalBlocks = createExternalBlocks({ pool });
}

// 画面設定が無ければ何もしない駆動部で動かす。これは「閉じた」と嘘をつかない
// （isSlotClosed が常に false）ので、消し込まれずチェックリストに残る
let driver = createNullDriver();
if (config.epark.mode !== 'off') {
  const profile = await loadProfile(config.epark.profilePath, readFile, config.epark.baseUrl).catch((err) => {
    console.error(`画面設定を読めません（${config.epark.profilePath}）: ${err.message}`);
    return null;
  });
  if (profile) driver = createBrowserDriver({ profile, config });
  else console.error('画面設定が無いため、EPARK は操作しません（config/epark-profile.example.json を参照）');
}

const sync = createEparkSync({ externalBlocks, driver, slack, config });
const summary = await sync.run();

if (summary.skippedReason === 'off') {
  console.log('EPARK_MODE=off のため実行しません（画面のチェックリストで運用します）');
} else {
  console.log(
    `モード ${config.epark.mode} / 対象 ${summary.total} / 反映 ${summary.done}` +
      ` / dry_run ${summary.dryRun} / 失敗 ${summary.failed}`
  );
}

if (pool) await pool.end();
process.exit(summary.failed > 0 ? 1 : 0);
