import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { middleware, SignatureValidationFailed } from '@line/bot-sdk';
import { loadConfig } from './config.js';
import { pool } from './db/pool.js';
import { createLineClient } from './line/client.js';
import { createIdTokenVerifier } from './line/verifyIdToken.js';
import { createSlackNotifier } from './notify/slack.js';
import { createLinkService } from './customers/linkService.js';
import { createWebhookHandler } from './webhook/handler.js';
import { createJobRunner } from './jobs/runner.js';
import { createPreReminderJob } from './jobs/preReminder.js';
import { createAfterVisitJob } from './jobs/afterVisit.js';
import { createFollowupClassifier } from './ai/classifyFollowup.js';

const config = loadConfig();
const lineClient = createLineClient({ config, pool });
const slack = createSlackNotifier({ webhookUrl: config.slackWebhookUrl });
const linkService = createLinkService({ pool, slack });
const classifier = createFollowupClassifier({ apiKey: config.anthropicApiKey });

const app = express();

app.get('/health', (_req, res) => res.json({ ok: true, sendMode: config.sendMode }));

// 署名検証には生ボディが必要なため、express.json() を webhook より前に適用しない
app.post(
  '/webhook',
  middleware({ channelSecret: config.line.channelSecret }),
  createWebhookHandler({ pool, lineClient, slack, linkService, classifier, liffUrl: config.liffUrl })
);

// ---- ここから下は JSON パースを使う（webhook 以外のルート） ----
app.use(express.json());

// LIFF 登録フォーム（静的ファイル）
const liffDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'liff');
app.use('/liff', express.static(liffDir));

// フロントに LIFF ID を渡す（HTML に焼き込まない）
app.get('/liff/config', (_req, res) => {
  if (!config.liffId) return res.status(503).json({ error: 'LIFF 未設定' });
  res.json({ liffId: config.liffId });
});

// LIFF 登録フォームの送信先。userId は ID トークン検証で得た sub のみを信用する
const verifyIdToken = config.liffChannelId
  ? createIdTokenVerifier({ channelId: config.liffChannelId })
  : null;

app.post('/liff/register', async (req, res) => {
  if (!verifyIdToken) return res.status(503).json({ ok: false, error: 'liff_not_configured' });
  try {
    const { idToken, name, phone, birthday, consent } = req.body ?? {};
    let payload;
    try {
      payload = await verifyIdToken(idToken);
    } catch {
      return res.status(401).json({ ok: false, error: 'invalid_token' });
    }
    const result = await linkService.registerFromLiff({
      lineUserId: payload.sub,
      name,
      phone,
      birthday,
      consent: Boolean(consent),
    });
    if (!result.ok) return res.status(400).json(result);
    // outcome はクライアントに返さない（他人の登録状況を推測させない）
    return res.json({ ok: true });
  } catch (err) {
    console.error(`[liff/register] 失敗: ${err.message}`);
    await slack.notifyError('LIFF 登録処理失敗', err);
    return res.status(500).json({ ok: false, error: 'internal' });
  }
});

// 署名検証失敗は 401 で即返す
app.use((err, _req, res, next) => {
  if (err instanceof SignatureValidationFailed) {
    return res.status(401).json({ error: 'invalid signature' });
  }
  console.error(`[http] ${err.message}`);
  return res.status(500).json({ error: 'internal error' });
});

// 毎日 10:00 JST の配信ジョブ（Phase 4・5 のジョブもここに追加していく）
const runner = createJobRunner({ slack });
runner.scheduleDaily({
  preReminder: createPreReminderJob({ pool, lineClient }),
  afterVisit: createAfterVisitJob({ pool, lineClient }),
});

app.listen(config.port, () => {
  console.log(`[boot] port=${config.port} SEND_MODE=${config.sendMode}`);
  if (config.sendMode === 'live') {
    console.log('[boot] ⚠️  本番送信モードで起動しています');
  }
});
