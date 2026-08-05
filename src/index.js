import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { middleware, SignatureValidationFailed } from '@line/bot-sdk';
import { loadConfig } from './config.js';
import { pool } from './db/pool.js';
import { createLineClient } from './line/client.js';
import { createIdTokenVerifier } from './line/verifyIdToken.js';
import { createSlackNotifier } from './notify/slack.js';
import { createStaffNotifier } from './notify/staffNotifier.js';
import { createSettings } from './settings.js';
import { createLinkService } from './customers/linkService.js';
import { createWebhookHandler } from './webhook/handler.js';
import { createJobRunner } from './jobs/runner.js';
import { createPreReminderJob } from './jobs/preReminder.js';
import { createAfterVisitJob } from './jobs/afterVisit.js';
import { createDormantJob } from './jobs/dormant.js';
import { createBirthdayJob } from './jobs/birthday.js';
import { createFollowupClassifier } from './ai/classifyFollowup.js';
import { createReservationService } from './reservations/service.js';
import { basicAuth, bearerAuth } from './http/auth.js';
import { createAdminRouter } from './http/adminRoutes.js';
import { createImportRouter } from './http/importRoutes.js';

const config = loadConfig();
const lineClient = createLineClient({ config, pool });
const settings = createSettings({ pool });
// スタッフ通知は staffNotifier に集約（Slack / LINE グループ / 両方を設定で切替）
const slackChannel = config.slackWebhookUrl
  ? createSlackNotifier({ webhookUrl: config.slackWebhookUrl })
  : null;
const slack = createStaffNotifier({ config, slack: slackChannel, lineClient, settings });
const linkService = createLinkService({ pool, slack });
const classifier = createFollowupClassifier({ apiKey: config.anthropicApiKey });

const app = express();

// デプロイ確認用にバージョンも返す
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

app.get('/health', (_req, res) =>
  res.json({ ok: true, sendMode: config.sendMode, version: pkg.version })
);

// 署名検証には生ボディが必要なため、express.json() を webhook より前に適用しない
app.post(
  '/webhook',
  middleware({ channelSecret: config.line.channelSecret }),
  createWebhookHandler({
    pool,
    lineClient,
    slack,
    linkService,
    classifier,
    settings,
    liffUrl: config.liffUrl,
  })
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

// 登録済みの顧客が「お客様情報」を開いたときに、現在の内容を出して変更できるようにする
app.post('/liff/profile', async (req, res) => {
  if (!verifyIdToken) return res.status(503).json({ error: 'liff_not_configured' });
  try {
    let payload;
    try {
      payload = await verifyIdToken(req.body?.idToken);
    } catch {
      return res.status(401).json({ error: 'invalid_token' });
    }
    const { rows } = await pool.query(
      `SELECT name, phone_norm, birthday, opt_out
       FROM customers
       WHERE line_user_id = $1 AND is_blocked = false`,
      [payload.sub]
    );
    // 電話番号が未登録なら本登録前（follow 時の仮レコード）とみなす
    if (rows.length === 0 || !rows[0].phone_norm) return res.json({ registered: false });

    const c = rows[0];
    return res.json({
      registered: true,
      name: c.name,
      phone: c.phone_norm,
      // DATE 型は JST 前提。ISO 変換で日付がずれないよう文字列のまま返す
      birthday: c.birthday ? new Date(c.birthday).toLocaleDateString('sv-SE') : null,
      consent: !c.opt_out,
    });
  } catch (err) {
    console.error(`[liff/profile] 失敗: ${err.message}`);
    return res.status(500).json({ error: 'internal' });
  }
});

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

// ---- 予約データの取り込み（Phase 6）----
const reservationService = createReservationService({ pool, slack, lineClient });

// LIFF 予約フォーム。顧客の特定は ID トークン検証で得た sub のみを信用する
app.post('/liff/reserve/options', async (req, res) => {
  if (!verifyIdToken) return res.status(503).json({ error: 'liff_not_configured' });
  try {
    let payload;
    try {
      payload = await verifyIdToken(req.body?.idToken);
    } catch {
      return res.status(401).json({ error: 'invalid_token' });
    }
    const { rows: customers } = await pool.query(
      `SELECT name FROM customers WHERE line_user_id = $1 AND is_blocked = false`,
      [payload.sub]
    );
    if (customers.length === 0) return res.json({ registered: false });

    const { rows: menus } = await pool.query(
      `SELECT id, name, duration_minutes FROM menus WHERE active = true ORDER BY sort_order, id`
    );
    const { rows: staff } = await pool.query(
      `SELECT id, name FROM staff WHERE active = true ORDER BY id`
    );
    return res.json({ registered: true, customerName: customers[0].name, menus, staff });
  } catch (err) {
    console.error(`[liff/reserve/options] 失敗: ${err.message}`);
    return res.status(500).json({ error: 'internal' });
  }
});

app.post('/liff/reserve', async (req, res) => {
  if (!verifyIdToken) return res.status(503).json({ ok: false, error: 'liff_not_configured' });
  try {
    const { idToken, menuId, staffId, reservedAt, note } = req.body ?? {};
    let payload;
    try {
      payload = await verifyIdToken(idToken);
    } catch {
      return res.status(401).json({ ok: false, error: 'invalid_token' });
    }
    const result = await reservationService.createRequest({
      lineUserId: payload.sub,
      menuId: menuId ? Number(menuId) : null,
      staffId: staffId ? Number(staffId) : null,
      reservedAt,
      note,
    });
    if (!result.ok) return res.status(400).json(result);
    // 予約 ID など内部情報は返さない
    return res.json({ ok: true });
  } catch (err) {
    console.error(`[liff/reserve] 失敗: ${err.message}`);
    await slack.notifyError('LIFF 予約リクエスト処理失敗', err);
    return res.status(500).json({ ok: false, error: 'internal' });
  }
});

// 管理画面（Basic 認証。ADMIN_USER / ADMIN_PASSWORD 未設定なら無効）
const adminGuard = basicAuth({ user: config.adminUser, password: config.adminPassword });
const adminDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'admin');
app.use('/admin', adminGuard, express.static(adminDir));
app.use('/api/admin', adminGuard, createAdminRouter({ pool, reservationService, lineClient, config }));

// 外部予約システムからの取り込み（Bearer トークン。INGEST_API_TOKEN 未設定なら無効）
app.use(
  '/api/import',
  bearerAuth({ token: config.ingestApiToken }),
  createImportRouter({ reservationService, slack })
);

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
runner.scheduleDaily(
  {
    preReminder: createPreReminderJob({ pool, lineClient }),
    afterVisit: createAfterVisitJob({ pool, lineClient }),
    dormant: createDormantJob({ pool, lineClient, dailyLimit: config.dormantDailyLimit }),
    birthday: createBirthdayJob({ pool, lineClient, couponUrl: config.birthdayCouponUrl }),
  },
  {
    lineClient,
    quotaWarnRatio: config.quotaWarnRatio,
    quotaWarnRemaining: config.quotaWarnRemaining,
  }
);

app.listen(config.port, () => {
  console.log(`[boot] port=${config.port} SEND_MODE=${config.sendMode}`);
  if (config.sendMode === 'live') {
    console.log('[boot] ⚠️  本番送信モードで起動しています');
  }
});
