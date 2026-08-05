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

毎日 10:00 JST に cron で以下を実行し、結果を1メッセージにまとめてスタッフへ通知する。

| ジョブ | 起点 |
|---|---|
| `preReminder` | 予約日の2日前に来店確認（ボタンで「伺います」/「変更したい」） |
| `afterVisit` | 来店7日後のフォロー。自由入力の返信は Claude Haiku で分類 |
| `dormant` | 最終来店から90日経過。同一顧客へは90日に1回まで |
| `birthday` | 誕生日当日にお祝い＋クーポン（2/29 生まれは平年 2/28） |

手動実行は `node scripts/run-job.js --job=preReminder --dry-run`。
管理画面の「テスト送信」からも1件ずつ試せる（`SEND_MODE=test` 時のみ、配信ログには残さない）。

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
取り込み API とスタッフ向け管理画面（`/admin/`。メニュー登録・予約の承認・来店登録）の使い方は
[docs/import-api.md](docs/import-api.md) を参照。

## デプロイ（インターネット公開）

VPS / EC2 / GCP Compute Engine + Docker Compose、または Render での公開手順を
[docs/deploy.md](docs/deploy.md) にまとめている。

## Webhook のローカル確認

cloudflared / ngrok でトンネルを張り、LINE Developers の Webhook URL に
`https://<トンネル>/webhook` を設定する。署名検証に失敗したリクエストは 401 で拒否される。
