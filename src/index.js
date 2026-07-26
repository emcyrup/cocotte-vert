import express from 'express';
import { middleware, SignatureValidationFailed } from '@line/bot-sdk';
import { loadConfig } from './config.js';
import { pool } from './db/pool.js';
import { createLineClient } from './line/client.js';
import { createSlackNotifier } from './notify/slack.js';
import { createWebhookHandler } from './webhook/handler.js';

const config = loadConfig();
const lineClient = createLineClient({ config, pool });
const slack = createSlackNotifier({ webhookUrl: config.slackWebhookUrl });

const app = express();

app.get('/health', (_req, res) => res.json({ ok: true, sendMode: config.sendMode }));

// 署名検証には生ボディが必要なため、express.json() を webhook より前に適用しない
app.post(
  '/webhook',
  middleware({ channelSecret: config.line.channelSecret }),
  createWebhookHandler({ pool, lineClient, slack })
);

// webhook 以外のルート（LIFF API 等、Phase 2 以降）はここから下で JSON パースを使う
app.use(express.json());

// 署名検証失敗は 401 で即返す
app.use((err, _req, res, next) => {
  if (err instanceof SignatureValidationFailed) {
    return res.status(401).json({ error: 'invalid signature' });
  }
  console.error(`[http] ${err.message}`);
  return res.status(500).json({ error: 'internal error' });
});

app.listen(config.port, () => {
  console.log(`[boot] port=${config.port} SEND_MODE=${config.sendMode}`);
  if (config.sendMode === 'live') {
    console.log('[boot] ⚠️  本番送信モードで起動しています');
  }
});
