# 本番サーバー（AWS・管理会社の共用環境）への移設手順

インフラ会社が用意した AWS の本番サーバーへ、このアプリをそのまま載せるための手順。
現在の検証環境（Docker Compose）とは**動かし方が変わる**ので、違いを先に押さえる。

> **この文書に実際の接続情報は書かない。**
> このリポジトリは公開設定のため、IP・SSH ユーザー名・ドメイン・パスワード・鍵ファイル名は
> すべて伏せてある。実際の値はインフラ会社から受け取った案内（PDF）と、
> サーバー上の `.env`（`chmod 600`）にだけ置く。

## 検証環境との違い

| | 検証環境（GCP） | 本番環境（AWS・共用） |
|---|---|---|
| 動かし方 | Docker Compose | **Node を直接起動**（`scripts/serve.sh`） |
| PostgreSQL | compose 内のコンテナ | **サーバー共通の PostgreSQL 18**（DB名は発行してもらう） |
| HTTPS | Caddy（同梱） | **管理会社の Nginx**（こちらは触らない） |
| 待ち受け | 127.0.0.1:3000 | **0.0.0.0:8017**（割り当てポート。変更不可） |
| sudo | 使える | **使えない**（Docker もグローバル install も不可） |
| 再起動後の復帰 | Docker の `restart: unless-stopped` | **crontab の `@reboot`** |

Docker が使えないため、`docker-compose.yml` と `Caddyfile` は本番では使わない
（検証環境用として残してある）。

## 事前にインフラ会社へ確認・依頼すること

1. **PostgreSQL のデータベース名**（「開発環境を踏襲した名前」で発行される。接続ユーザーとパスワードは共通）
2. **Nginx のリバースプロキシ設定**。割り当てサブドメインを、割り当てポートへ流してもらう。
   このとき **`client_max_body_size` を 8m 以上**にしてもらうこと。
   予約CSVの取り込み（最大5MB）と SNS 写真の投稿（最大8MB）が Nginx の既定値（1MB）で弾かれるため
3. GitHub リポジトリ（`emcyrup/cocotte-vert`）への招待、またはサーバーからの `git clone` 用の鍵登録

## 進め方は2通り

**自動デプロイを使う場合**（推奨）は、先に手順8で GitHub の Secret / Variable を登録してしまう。
`main` が更新された時点でリポジトリの取得まで自動で走り、`.env` が無い旨で止まる。
そのあと手順2（`.env` の作成）と手順4（データ移行）だけをサーバー上で行い、
Actions を再実行すれば起動する。

**手で入れる場合**は、以下を上から順に。

## 1. サーバーに入って取ってくる

```bash
ssh -i <配布された .pem> <SSHユーザー名>@<サーバーIP>

# 仮想環境（venv）は Python 用。このアプリは Node なので有効化は不要
node -v      # v22 系であることを確認
git clone <リポジトリのURL> cocotte-vert
cd cocotte-vert
npm ci --omit=dev
```

## 2. `.env` を作る

```bash
cp .env.example .env
chmod 600 .env
nano .env
```

本番で必ず設定するもの。

```
# 割り当てられたポートを厳守する。0.0.0.0 で待ち受ける（Node の既定）
PORT=8017

# 共通 PostgreSQL。DB 名は発行されたもの
DATABASE_URL=postgres://<ユーザー>:<パスワード>@127.0.0.1:5432/<DB名>

# 外から見える自分の URL。Instagram が投稿画像を取りに来るのと、
# グループLINEで案内する管理画面のリンクに使う
PUBLIC_BASE_URL=https://<割り当てサブドメイン>

TZ=Asia/Tokyo

# 検証が済むまでは dry_run のまま。live は移行を確認してから切り替える
SEND_MODE=dry_run
```

LINE・Slack・Claude・管理画面のパスワードなど、残りは**検証環境の `.env` からそのまま写す**。
`POSTGRES_PASSWORD` と `DOMAIN` は Docker Compose 用なので本番では不要。

## 3. 起動する

```bash
./scripts/serve.sh start
```

マイグレーションを流してからアプリを起動し、`/health` に応答があるまで待つ。
失敗したらログの末尾を出して止まるので、黙って起動していないことはない。

```bash
./scripts/serve.sh status    # 動いているか
./scripts/serve.sh logs      # ログを追う
./scripts/serve.sh restart   # 入れ替え後の再起動
./scripts/serve.sh stop
```

ログは `run/app.log`（20MB を超えたら起動時に1世代退避）。

### 再起動後に自動で立ち上げる

sudo が無いため systemd のユニットは置けない。crontab（ユーザー権限で編集できる）に登録する。

```bash
crontab -e
```

```cron
@reboot cd $HOME/cocotte-vert && ./scripts/serve.sh start >> $HOME/cocotte-vert/run/boot.log 2>&1
```

配信ジョブ（毎朝10時）は**アプリの中の node-cron が持っている**ので、crontab には書かない。

## 4. データを移す

検証環境のデータ（顧客・予約・配信ログ・シフト等）をそのまま持っていく。

```bash
# 検証環境（Docker Compose 側）で
docker compose exec -T db pg_dump -U postgres --no-owner --no-acl cocotte_vert > dump.sql

# 本番サーバーへ送る
scp -i <配布された .pem> dump.sql <SSHユーザー名>@<サーバーIP>:~/

# 本番サーバーで（先に `serve.sh start` を一度通し、スキーマを作っておく）
./scripts/serve.sh stop
psql "$DATABASE_URL" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
psql "$DATABASE_URL" -f ~/dump.sql
./scripts/serve.sh start
rm ~/dump.sql        # 顧客情報が入っているので置きっぱなしにしない
```

移した直後に必ず確認する。

```bash
psql "$DATABASE_URL" -c "SELECT count(*) FROM customers;"
psql "$DATABASE_URL" -c "SELECT count(*) FROM reservations;"
psql "$DATABASE_URL" -c "SELECT max(version) FROM schema_migrations;"
```

**`message_logs` は必ず一緒に移す。** `dedupe_key` の UNIQUE 制約が二重送信を防ぐ唯一の砦なので、
これが空だと移設直後に「すでに送った前々日確認」がもう一度飛ぶ。

## 5. LINE 側の向き先を変える

ここを忘れると、サーバーだけ移って動かない。**Nginx の疎通を確認してから**行う。

| 変えるもの | 変更先 |
|---|---|
| LINE Developers → Messaging API → Webhook URL | `https://<割り当てサブドメイン>/webhook` |
| LINE Developers → LIFF → エンドポイント URL | `https://<割り当てサブドメイン>/liff/index.html` |
| 外部連携（予約取り込み API 等）の宛先 | 同じサブドメインへ |

LIFF の配下ページ（`reserve.html` / `staff.html` / `staff-reserve.html`）は
エンドポイント URL からの相対で開くため、**個別の設定変更は不要**。

切り替えたら、Webhook の「検証」ボタンで 200 が返ることを確認する。

## 6. 動作確認

```bash
# サーバー内から
curl -s http://127.0.0.1:8017/health

# 外から（Nginx 経由）
curl -s https://<割り当てサブドメイン>/health
```

そのうえで画面と LINE を一通り。

- 管理画面 `https://<割り当てサブドメイン>/mock/` が Basic 認証つきで開く
- 顧客一覧・予約カレンダーに移したデータが出ている
- スタッフ用グループで「予約確認」に応答が返る
- 「予約登録」でフォームのボタンが返り、フォームが開いてお客様を探せる

## 7. 本番送信に切り替える

ここまで `SEND_MODE=dry_run` のまま確認する。実際に配信を始めるときだけ切り替える。

```bash
# まず自分の LINE にだけ飛ばして文面を確認する
sed -i "s/^SEND_MODE=.*/SEND_MODE=test/" .env   # TEST_LINE_USER_ID も設定しておく
./scripts/serve.sh restart

# 問題なければ本番送信へ
sed -i "s/^SEND_MODE=.*/SEND_MODE=live/" .env
./scripts/serve.sh restart
```

**旧サーバー（検証環境）は必ず止める。** 両方が `live` で動いていると、
別々のデータベースを見ているため `dedupe_key` が効かず、同じお客様に二重で届く。

```bash
# 旧サーバーで
docker compose down
```

## 8. 自動デプロイをこちらへ向ける

GitHub の Settings → Secrets and variables → Actions で:

| 種類 | キー | 値 |
|---|---|---|
| Secret | `VM_HOST` | 本番サーバーの IP |
| Secret | `VM_USER` | 配布された SSH ユーザー名 |
| Secret | `VM_SSH_KEY` | 配布された `.pem` の中身（`-----BEGIN`〜`-----END` を含む全文） |
| Variable | `DEPLOY_ENABLED` | `true` |
| Variable | `DEPLOY_STYLE` | `plain` |
| Variable | `DEPLOY_PORT` | 割り当てポート |

以降、`main` が更新されるたびに、サーバー上で次が走る。

```
（未取得なら git clone）→ git pull → npm ci --omit=dev → ./scripts/serve.sh restart
```

**リポジトリの取得も自動で行う**ので、手でやることは `.env` の作成（手順2）だけ。
`.env` が無ければ `serve.sh` が「.env がありません」で止まり、Actions のログにそのまま出る。

`.pem` は GitHub Actions の Secret として登録する。サーバーの `~/.ssh/authorized_keys` に
すでにその公開鍵が入っているため、追加の鍵登録は不要。

## つまずきやすいところ

| 症状 | 原因 |
|---|---|
| `EADDRINUSE` で起動しない | 前のプロセスが残っている。`./scripts/serve.sh stop` してから start |
| Nginx が 502 を返す | アプリが落ちている。`./scripts/serve.sh status` と `run/app.log` を見る |
| CSV の取り込みが 413 で失敗する | Nginx の `client_max_body_size` が既定（1MB）のまま。管理会社へ依頼する |
| 配信が19時に走る | `TZ=Asia/Tokyo` が `.env` に無い。cron 自体は JST 指定だが、揃えておく |
| Webhook が届かない | LINE Developers 側の Webhook URL が旧サーバーのまま |
| 再起動後に上がってこない | crontab の `@reboot` を入れ忘れている |
