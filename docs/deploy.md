# デプロイ手順

Webhook と LIFF には**固定の HTTPS URL** が必要。構成は3通り。

| 構成 | 対象 |
|---|---|
| A. 既存 EC2（Nginx 稼働中）+ Docker Compose | 既存のマルチテナント EC2 に載せる場合 |
| B. 新規 VM / VPS + Docker Compose（Caddy 同梱） | **現在の検証環境はこれ**（GCP Compute Engine） |
| C. Render（PaaS） | サーバー管理をしたくない場合（月約 $14、ドメイン不要） |

---

## 構成 A: 既存 EC2（Nginx 稼働中）

アプリと PostgreSQL をコンテナで起動し、既存の Nginx から `127.0.0.1:3000` へプロキシする。
アプリのポートはループバックにのみ束縛されるため、外部から直接は届かない。

### 1. DNS

サブドメインを1つ決め（例 `line.example.com`）、DNS に **A レコード**を追加して EC2 の IP に向ける。

### 2. アプリの起動

```bash
# EC2 に SSH して（Docker 未導入なら sudo apt install docker.io docker-compose-v2）
git clone https://github.com/emcyrup/cocotte-vert.git
cd cocotte-vert
cp .env.example .env
nano .env
```

`.env` の設定内容：

```
# compose 用（追記する）
POSTGRES_PASSWORD=強いパスワードを生成して設定

# LINE / Slack（テスト用チャネルの値から始める）
LINE_CHANNEL_ACCESS_TOKEN=...
LINE_CHANNEL_SECRET=...
LIFF_ID=...
SLACK_WEBHOOK_URL=...

# 誤爆防止: 本番でも当面 dry_run のまま。live は実行時に明示して渡す
SEND_MODE=dry_run
```

`DATABASE_URL` は compose が内部 DB を指すよう自動設定するため空で良い。

```bash
docker compose up -d --build
docker compose logs -f app   # [migrate] 完了 → [boot] port=3000 SEND_MODE=dry_run
curl http://127.0.0.1:3000/health   # {"ok":true,"sendMode":"dry_run"}
```

### 3. Nginx の vhost 追加

`/etc/nginx/sites-available/line.example.com` を作成（パスは既存構成の流儀に合わせる）：

```nginx
server {
    listen 80;
    server_name line.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/line.example.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# HTTPS 化（certbot が listen 443 の設定とリダイレクトを自動追記する）
sudo certbot --nginx -d line.example.com
```

certbot 未導入なら `sudo apt install certbot python3-certbot-nginx`。

### 4. 確認

```bash
curl https://line.example.com/health   # {"ok":true,"sendMode":"dry_run"}
```

### 更新時

```bash
cd cocotte-vert && git pull
docker compose up -d --build   # マイグレーションも自動適用
```

### 運用メモ

- DB バックアップ: `docker compose exec db pg_dump -U postgres cocotte_vert > backup.sql`（cron で日次推奨）
- ログ: `docker compose logs -f app`
- 送信モード切替（実機検証後）: `.env` は書き換えず実行時に渡す
  `docker compose run --rm -e SEND_MODE=test app node scripts/run-job.js --job=preReminder`
- 既存 EC2 のホスト側 PostgreSQL に相乗りしたい場合は、`.env` の `DATABASE_URL` にホスト DB を指定し、`docker-compose.yml` の `db` サービスと `environment.DATABASE_URL` を削る（コンテナからホストへは `host.docker.internal` ではなく EC2 のプライベート IP か `--network host` を使う）。迷ったら同梱 DB のままで良い

---

## 構成 B: 新規 VM / VPS（リバースプロキシなし）

Caddy（HTTPS 自動化）を同梱した standalone プロファイルで起動する。

前提: ポート 80/443 開放、DNS A レコード設定済み。

```bash
# .env に構成 A の内容に加えて DOMAIN を設定
DOMAIN=line.example.com

docker compose --profile standalone up -d --build
curl https://line.example.com/health
```

### GCP Compute Engine の場合

- 外部 IP は**静的**にする（エフェメラルのままだと再起動で変わり、DNS と証明書が壊れる）
- VPC ファイアウォールで 80/443 を許可する（既定の `default-allow-http/https` タグを付けるか、
  ルールを追加する）。**ここを開けないと Caddy が Let's Encrypt の検証に失敗し、HTTPS にならない**
- 操作は必ず **VM に SSH した状態**で行う。Cloud Shell は別マシンで外部からの通信を受けられないため、
  Cloud Shell 上で起動しても Webhook は届かない（プロンプトが `@cloudshell` なら間違い）
- 無料ドメインで済ませる場合は DuckDNS などの A レコードを VM の外部 IP に向ける

---

## 構成 C: Render

1. https://render.com にサインアップし、GitHub リポジトリを接続
2. ダッシュボード → New + → **Blueprint** → このリポジトリを選択（`render.yaml` が読まれる）
3. 環境変数 `LINE_CHANNEL_ACCESS_TOKEN` / `LINE_CHANNEL_SECRET` / `LIFF_ID` / `SLACK_WEBHOOK_URL` を入力
4. デプロイ完了後の `https://cocotte-vert-xxxx.onrender.com` が固定 URL

git push で自動再デプロイ。Free プランはスリープして Webhook を取りこぼすため Starter 以上を使うこと。

---

## LINE 側の URL 設定（全構成共通）

- Webhook URL: `https://<URL>/webhook`
  （Messaging API 設定タブ → 編集 → 保存 → **検証** → **Webhook の利用をオン**）
- LIFF エンドポイント URL: `https://<URL>/liff/`
  （LINE ログインチャネル → LIFF タブ）

## CI/CD（テスト自動実行と VM 自動デプロイ）

`.github/workflows/ci.yml` により、プッシュ・PR のたびにテストが自動実行される。
さらに以下を設定すると、**main へのマージ → テスト成功 → VM へ自動デプロイ**まで自動化される。

### 1. VM にデプロイ用 SSH 鍵を用意

ローカル（または VM 上）で鍵ペアを作り、公開鍵を VM に登録する:

```bash
ssh-keygen -t ed25519 -f deploy_key -N "" -C "github-actions-deploy"
# 公開鍵を VM の authorized_keys へ追加
cat deploy_key.pub >> ~/.ssh/authorized_keys   # VM 上で実行する場合
```

### 2. GitHub リポジトリに登録

Settings → Secrets and variables → Actions:

| 種別 | 名前 | 値 |
|---|---|---|
| Secret | `VM_HOST` | VM の IP またはドメイン |
| Secret | `VM_USER` | SSH ユーザー名（例: `iwako105`） |
| Secret | `VM_SSH_KEY` | `deploy_key`（秘密鍵ファイル）の中身全文 |
| Variable | `DEPLOY_ENABLED` | `true` |

`DEPLOY_ENABLED` を設定するまでデプロイはスキップされる（テストのみ実行）。

### 3. VM 側を main ブランチに切り替え

自動デプロイは main を反映するため、VM のリポジトリを main に切り替えておく:

```bash
cd cocotte-vert && git fetch origin main && git checkout main && git pull origin main
docker compose --profile standalone up -d --build
```

### 動作

- 全ブランチのプッシュ / PR → `npm test`（98件）
- main へのプッシュ（PR マージ含む）→ テスト成功後、SSH で VM に入り
  `git pull` + `docker compose up -d --build` + ヘルスチェックまで実行
- 失敗時は GitHub の Actions タブに赤で表示される

## どの構成でも守ること

- `SEND_MODE` は本番環境でも **dry_run のまま**。`live` は動作検証後に実行時に明示して切り替える（CLAUDE.md の運用ルール）
- 資格情報はリポジトリにコミットしない
- まず**テスト用チャネル**の値で公開し、実機確認が全て通ってから本番用チャネルに切り替える
