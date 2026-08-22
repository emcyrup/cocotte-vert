#!/usr/bin/env node
// .env の設定状況をまとめて確かめる。
//
//   Docker のサーバー: docker compose exec app node scripts/check-env.js
//   Docker 無しのサーバー: node --env-file-if-exists=.env scripts/check-env.js
//
// 読み取りのみで、送信も設定変更も一切行わない（SEND_MODE に関わらず安全）。
// Slack だけは叩くと実際に通知が飛ぶため、設定の有無しか見ない。
//
// **秘密の値は出力しない。** 出力をそのまま貼って相談できるようにしてある。
// 直すべき点があれば終了コード 1 で終わる。

import { readFile } from 'node:fs/promises';
import { loadConfig } from '../src/config.js';
import { loadStoreProfile } from '../src/store.js';
import { pool } from '../src/db/pool.js';
import { createInstagramClient } from '../src/instagram/client.js';
import { createThreadsClient } from '../src/threads/client.js';
import {
  requiredRows, sendModeRows, urlRows, optionalRows, storeRows, hasProblem,
  duplicateKeys, duplicateRows,
} from '../src/checkEnv.js';

// 1つが固まっても全体を止めない
const TIMEOUT_MS = 10000;
const skipped = { ok: false, skipped: true, detail: '未設定' };

async function attempt(fn) {
  try {
    return { ok: true, detail: await fn() };
  } catch (err) {
    return { ok: false, detail: err.message };
  }
}

async function checkDb() {
  return attempt(async () => {
    const { rows } = await pool.query('SELECT current_database() AS db');
    const { rows: applied } = await pool.query(
      'SELECT max(version) AS v FROM schema_migrations'
    );
    return `${rows[0].db} / 適用済み ${applied[0].v ?? '(なし)'}`;
  });
}

async function checkLine(config) {
  return attempt(async () => {
    const { messagingApi } = await import('@line/bot-sdk');
    const client = new messagingApi.MessagingApiClient({
      channelAccessToken: config.line.channelAccessToken,
    });
    const bot = await client.getBotInfo();
    const mode = bot.chatMode === 'bot' ? '応答モード: Bot' : `応答モード: ${bot.chatMode}（Webhook が飛びません）`;
    return `${bot.displayName} ${bot.basicId} / ${mode}`;
  });
}

async function checkAnthropic(config) {
  if (!config.anthropicApiKey) return skipped;
  return attempt(async () => {
    // 一覧の取得は読み取りのみで、トークンを消費しない
    const res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
      headers: {
        'x-api-key': config.anthropicApiKey,
        'anthropic-version': '2023-06-01',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return 'ok';
  });
}

async function checkSns(client, token) {
  if (!token) return skipped;
  return attempt(async () => {
    const me = await client.whoAmI();
    return `@${me.username}`;
  });
}

async function main() {
  const config = loadConfig();
  const store = loadStoreProfile();

  const [db, line, anthropic, instagram, threads] = await Promise.all([
    checkDb(),
    checkLine(config),
    checkAnthropic(config),
    checkSns(createInstagramClient({ config }), config.igAccessToken),
    checkSns(createThreadsClient({ config }), config.threadsAccessToken),
  ]);
  const checks = { db, line, anthropic, instagram, threads };

  // .env そのものも見る。同じキーが2行あると後の行が静かに勝つため
  const envText = await readFile('.env', 'utf8').catch(() => '');
  const dupes = duplicateRows(duplicateKeys(envText));

  const sections = [
    ['必須（欠けると起動しません）', [...requiredRows(config, checks), ...dupes]],
    ['送信の設定', sendModeRows(config)],
    ['外から見える URL', urlRows(config)],
    ['任意の連携', optionalRows(config, checks)],
    ['店舗と配信の設定', storeRows(config, store)],
  ];

  const all = [];
  for (const [title, rows] of sections) {
    console.log(`\n== ${title} ==`);
    for (const row of rows) console.log(row);
    all.push(...rows);
  }

  const problem = hasProblem(all);
  console.log(
    problem
      ? '\n✗ の付いた項目があります。上から順に直してください。\n'
      : '\n必須の設定はすべて通りました。\n'
  );
  await pool.end();
  process.exit(problem ? 1 : 0);
}

main().catch(async (err) => {
  // 起動できない理由（必須変数の欠落など）はそのまま出す
  console.error(`\n[check-env] 失敗: ${err.message}\n`);
  await pool.end().catch(() => {});
  process.exit(1);
});
