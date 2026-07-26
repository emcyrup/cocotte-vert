# デプロイ手順

Webhook と LIFF には**固定の HTTPS URL** が必要。以下のどちらかで公開する。

| | 構成 A: VPS / EC2 + Docker Compose | 構成 B: Render（PaaS） |
|---|---|---|
| 向いている人 | 既にサーバーを持っている | サーバー管理をしたくない |
| 月額目安 | サーバー代のみ（既存なら追加ゼロ） | 約 $14（Web $7 + DB $7） |
| ドメイン | 必要（サブドメインで可） | 不要（`xxx.onrender.com` が付与される） |
| HTTPS 証明書 | Caddy が自動取得・自動更新 | 自動 |

---

## 構成 A: VPS / EC2 + Docker Compose

アプリ・PostgreSQL・Caddy（HTTPS リバースプロキシ）を `docker-compose.yml` でまとめて起動する。

### 前提

- Docker と Docker Compose が入ったサーバー（Ubuntu 22.04+ 推奨）
- ポート **80 と 443** が開いていること（EC2 はセキュリティグループで開放）
- ドメインの DNS に **A レコード**を1件追加: `line.example.com → サーバーの IP`

### 手順

```bash
# 1. サーバーに SSH して取得
git clone https://github.com/emcyrup/cocotte-vert.git
cd cocotte-vert

# 2. 環境変数を設定
cp .env.example .env
nano .env
```

`.env` に以下を設定する（compose 用の2行を**追記**する点に注意）:

```
# compose 用（追記）
POSTGRES_PASSWORD=強いパスワードを生成して設定
DOMAIN=line.example.com

# LINE / Slack（取得済みの値）
LINE_CHANNEL_ACCESS_TOKEN=...
LINE_CHANNEL_SECRET=...
LIFF_ID=...
SLACK_WEBHOOK_URL=...

# 誤爆防止: 本番でも当面 dry_run のまま。live は手動で切り替える
SEND_MODE=dry_run
```

`DATABASE_URL` は compose が内部の DB を指すよう自動設定するため、`.env` の値は使われない（空のままで良い）。

```bash
# 3. 起動（初回はビルド + マイグレーション適用まで自動で行われる）
docker compose up -d --build

# 4. 確認
docker compose logs -f app     # [migrate] 完了 → [boot] port=3000 SEND_MODE=dry_run
curl https://line.example.com/health   # {"ok":true,"sendMode":"dry_run"}
```

### LINE 側の URL 設定

- Webhook URL: `https://line.example.com/webhook`（Messaging API 設定タブ → 検証 → Webhook の利用オン）
- LIFF エンドポイント URL: `https://line.example.com/liff/`

### 更新時

```bash
git pull
docker compose up -d --build   # マイグレーションも自動適用
```

### 運用メモ

- DB のバックアップ: `docker compose exec db pg_dump -U postgres cocotte_vert > backup.sql`（cron で日次推奨）
- ログ確認: `docker compose logs -f app`
- 送信モード切替（Phase 3 の実機検証後）: `.env` の `SEND_MODE` は書き換えず、`docker compose run --rm -e SEND_MODE=test app node scripts/run-job.js --job=...` のように実行時に渡す

---

## 構成 B: Render

1. https://render.com にサインアップし、GitHub リポジトリを接続
2. ダッシュボード → New + → **Blueprint** → このリポジトリを選択（`render.yaml` が読まれる）
3. 環境変数の入力を求められるので `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_CHANNEL_SECRET` / `LIFF_ID` / `SLACK_WEBHOOK_URL` を設定
4. デプロイ完了後、`https://cocotte-vert-xxxx.onrender.com` が固定 URL になる
   - Webhook URL: `https://…onrender.com/webhook`
   - LIFF エンドポイント URL: `https://…onrender.com/liff/`

git push するたびに自動で再デプロイされる（起動時にマイグレーションも適用される）。

**注意**: Free プランは15分でスリープし Webhook を取りこぼすため、Web サービスは Starter 以上を使うこと。

---

## どちらの構成でも守ること

- `SEND_MODE` は本番環境でも **dry_run のまま**にしておき、`live` は動作検証が済んでから実行時に明示して切り替える（CLAUDE.md の運用ルール）
- 資格情報（トークン・シークレット）はリポジトリにコミットしない。`.env` またはダッシュボードの環境変数でのみ管理する
- 本番用チャネルとテスト用チャネルの値を取り違えないこと。まずテスト用チャネルの値で公開し、実機確認が全て通ってから本番用に切り替える
