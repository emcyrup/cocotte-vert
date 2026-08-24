// EPARK 側の枠を閉じる／開け直す作業を、手で1回だけ流す。
//
// 使い方:
//   node scripts/run-epark-sync.js              # .env の EPARK_MODE に従う
//   node scripts/run-epark-sync.js --dry-run    # ログインして読むだけに落として実行
//
// --dry-run は安全側への上書きだけを許す（live へ上げる指定は用意しない）。
// live にするときは .env ではなく実行時に EPARK_MODE=live を明示的に渡すこと。

if (process.argv.includes('--dry-run')) {
  process.env.EPARK_MODE = 'dry_run';
}

// EPARK_MODE を確定させてから読み込む（config はロード時に環境変数を固定するため動的 import）
const { loadConfig } = await import('../src/config.js');
const { pool } = await import('../src/db/pool.js');
const { createSlackNotifier } = await import('../src/notify/slack.js');
const { createExternalBlocks } = await import('../src/reservations/externalBlock.js');
const { createEparkSync } = await import('../src/epark/sync.js');
const { createNullDriver } = await import('../src/epark/driver.js');
const { createBrowserDriver } = await import('../src/epark/browserDriver.js');
const { loadProfile } = await import('../src/epark/profile.js');
const { readFile } = await import('node:fs/promises');

const config = loadConfig();
const slack = createSlackNotifier({ webhookUrl: config.slackWebhookUrl });
const externalBlocks = createExternalBlocks({ pool });

// 画面設定が無ければ何もしない駆動部で動かす。これは「閉じた」と嘘をつかない
// （isSlotClosed が常に false）ので、消し込まれずチェックリストに残る
let driver = createNullDriver();
if (config.epark.mode !== 'off') {
  const profile = await loadProfile(config.epark.profilePath, readFile).catch((err) => {
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
    `対象 ${summary.total} / 反映 ${summary.done} / dry_run ${summary.dryRun} / 失敗 ${summary.failed}`
  );
}

await pool.end();
process.exit(summary.failed > 0 ? 1 : 0);
