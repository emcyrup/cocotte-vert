# cocotte-vert — LINE リマインド配信システム

店舗の LINE 公式アカウントから、予約日・来店日・誕生日を起点にした4種類の自動配信を行うシステム。
詳細は [CLAUDE.md](CLAUDE.md)・[docs/spec.md](docs/spec.md)・[docs/roadmap.md](docs/roadmap.md) を参照。

## セットアップ

```bash
npm install
cp .env.example .env   # 値を埋める（テスト用チャネルの資格情報を使うこと）
npm run migrate        # PostgreSQL にスキーマを適用
npm start
```

## 送信モード（誤爆防止）

送信は `SEND_MODE` で3段階に制御される。実装は `src/line/client.js` に集約。

| モード | 挙動 |
|---|---|
| `dry_run`（デフォルト） | 送信せず、対象者と本文を標準出力に出すだけ。DB にも書かない |
| `test` | 対象者が誰であっても `TEST_LINE_USER_ID` に宛先を差し替えて送信 |
| `live` | 本番送信。**env ファイルに書かず実行時に明示的に渡す** |

## 配信ジョブ

毎日 10:00 JST に cron で以下を実行する。実行結果は通数を消費しないよう Push せず保存し、
スタッフ用 LINE グループで **「配信結果」** と発言すると応答メッセージで返す（応答は無料）。

| ジョブ | 起点 |
|---|---|
| `preReminder` | 予約日の2日前に来店確認（ボタンで「伺います」/「変更したい」） |
| `afterVisit` | 来店7日後のフォロー。自由入力の返信は Claude Haiku で分類 |
| `dormant` | 最終来店から90日経過。同一顧客へは90日に1回まで |
| `birthday` | 誕生日当日にお祝い＋クーポン（2/29 生まれは平年 2/28） |

手動実行は `node scripts/run-job.js --job=preReminder --dry-run`。
管理画面の「テスト送信」（`/mock/#test`）からも1件ずつ試せる（配信ログには残さない）。

## 顧客向け画面（LIFF）

リッチメニューから2つの LIFF ページを開く。`node scripts/setup-richmenu.js` で登録する。

| ページ | 用途 |
|---|---|
| `/liff/` | お客様情報の登録。登録済みなら現在の内容を表示する**確認・変更フォーム**になる |
| `/liff/reserve.html` | 予約リクエスト。希望日時・メニュー・担当・ご要望を送信する |

予約は**承認制**。顧客の送信時は `requested`（承認待ち）で作られ、管理画面でスタッフが承認して
初めて `confirmed` になる。配信ジョブは `confirmed` のみを対象にするため、未承認の予約に
前々日確認が飛ぶことはない。

## テスト

```bash
npm test
```

`main` への push と全ブランチの push で GitHub Actions がテストを実行し、
`main` は成功後に SSH で VM へ自動デプロイされる（`.github/workflows/`）。

## 予約データの取り込み・管理画面

予約の入口は3つ（LIFF 予約フォーム / 外部予約システムの取り込み API / 管理画面での手入力）で、
書き込みは `src/reservations/service.js` に集約している。
取り込み API とスタッフ向け店舗管理画面（`/mock/`。メニュー登録・予約の承認・来店登録）の使い方は
[docs/import-api.md](docs/import-api.md) を参照。

## スタッフ勤怠（シフト変更申請）

スタッフが公式LINE へ自由な文章でシフトの希望を送ると、申請として店長に届き、
店舗管理画面で承認・却下すると本人へ LINE で自動通知される。申請文の解釈は Claude Haiku。
連携の手順と書き方の例は [docs/shift-requests.md](docs/shift-requests.md) を参照。

## Instagram / スレッズ投稿

管理画面から店舗の Instagram へ写真を投稿できる（複数枚のカルーセル・11枚以上の自動2分割・
予約投稿）。`IG_POST_MODE=dry_run` が既定で、`live` にするまで実投稿されない。
Meta 側のセットアップは [docs/instagram.md](docs/instagram.md) を参照。

同じ画面で**スレッズ**にも投稿できる。Instagram 用に並べた写真の左上にチェックを入れると、
その分だけが別の投稿としてスレッズへ出る（`THREADS_POST_MODE=dry_run` が既定）。
設定は [docs/threads.md](docs/threads.md) を参照。

## テスト送信

管理画面 `/mock/#test` から、顧客へ送りうるメッセージを**全種類**テスト送信できる
（前々日確認・来店フォロー・休眠・誕生日・予約の受付/確定/見送り）。宛先はサーバ側で
常に `TEST_LINE_USER_ID` に固定され、`SEND_MODE=live` では誤配信防止のため拒否される。

`TEST_LINE_USER_ID` に専用アカウントを用意する必要はなく、**店長・スタッフ本人の LINE**
でよい。条件はそのアカウントが運用中の公式アカウントを**友だち追加している**こと
（userId はアカウントごとに違う値のため）。値の調べ方は
[docs/switch-account.md](docs/switch-account.md) の Step 6 を参照。

## リマインドの ON/OFF

実装済みの4種（前々日確認・来店7日後フォロー・休眠フォロー・誕生日）は**店舗全体**と
**お客様ごと**の2段階で止められ、両方 ON のときだけ送られる。

| 単位 | 場所 | 保存先 |
|---|---|---|
| 店舗全体 | `/mock/#rem`（個別・一括） | `app_settings` |
| お客様ごと | ペットカルテの「飼い主様へのリマインド設定」 | `customer_reminder_settings` |
| その方の配信を全部止める | 顧客一覧の「編集」→ 配信停止 | `customers.opt_out` |

店舗全体の設定は日次の自動実行と `scripts/run-job.js` の手動実行の**どちらも同じ設定を見る**。
お客様ごとの設定は各ジョブの SQL で対象から外す。ジョブは飼い主様単位で送るため、
わんちゃんごとには分けられない。

## 店舗管理画面

`/mock/` がスタッフ向けの店舗管理画面（Basic 認証の内側）。管理 API に届く本番環境では
**実データで動き**、単体で開いたときは提案・要件確認用のデモとして動く。
予約管理・ペットカルテ・シフト申請・SNS投稿は実装済みで、予約カレンダーと週次シフト表は構想。
切り分けの詳細は [src/mock/README.md](src/mock/README.md) を参照。

## 運用中の公式アカウントへの接続

テスト用チャネルから店舗の LINE 公式アカウントに繋ぎ替える手順は
[docs/switch-account.md](docs/switch-account.md) を参照。

すでにお客様が友だちにいるアカウントの場合、**Webhook URL は1つしか設定できない**
（他ツールの連携を上書きすると黙って止まる）、**リッチメニューの登録は既存メニューを
差し替える**など、既存の運用を壊す操作がある。`SEND_MODE` は最後まで `dry_run` のままにし、
配信は前々日確認から段階的に始めること。

切り替え後は `node scripts/check-line.js` で、どのアカウントに繋がっているか
（表示名・ベーシック ID・応答モード・Webhook の疎通・月間通数）を確認できる。

## デプロイ（インターネット公開）

VPS / EC2 / GCP Compute Engine + Docker Compose、または Render での公開手順を
[docs/deploy.md](docs/deploy.md) にまとめている。

## Webhook のローカル確認

cloudflared / ngrok でトンネルを張り、LINE Developers の Webhook URL に
`https://<トンネル>/webhook` を設定する。署名検証に失敗したリクエストは 401 で拒否される。
