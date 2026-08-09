# 実装ロードマップ

フェーズ順に進める。各フェーズの「完了条件」を満たすまで次に進まない。

> **進捗（2026-08 時点）: Phase 0〜6 は実装・実機確認とも完了。Phase 7 は未着手（任意）。**
> 検証環境（GCP VM + Docker Compose）で稼働中。送信モードは `test` のため顧客には配信されない。
> 実店舗投入までに必要な作業は「本番投入前チェックリスト」を参照。

---

## Phase 0 — アカウントとチャネルの準備（手作業）

Claude Code の作業ではなく、事前に人手で済ませておく項目。

- [ ] LINE 公式アカウント開設（Messaging API を使うので**認証済アカウント不要、未認証で可**）
- [ ] LINE Official Account Manager → 設定 → 応答設定で **「応答モード：Bot」「Webhook：オン」「応答メッセージ：オフ」** にする（ここが未設定だと Webhook が飛ばず、原因究明で必ず時間を溶かす）
- [ ] LINE Developers でプロバイダー／Messaging API チャネル作成、チャネルアクセストークン（長期）とチャネルシークレットを取得
- [ ] LIFF アプリを作成（サイズ: Full、`liff.getProfile` のスコープ有効化）
- [ ] Slack Incoming Webhook URL 発行
- [ ] ローカル開発用のトンネル（cloudflared または ngrok）を用意
- [ ] **テスト用の LINE 公式アカウントを本番とは別に1つ作る**（誤爆防止のため必須）

**完了条件**: テスト用チャネルのトークンで、自分自身に Push が1通届くこと。

---

## Phase 1 — 基盤

- Express 起動、`config.js` で環境変数を検証
- PostgreSQL 接続、`src/db/migrations/` を `npm run migrate` で適用
  （スキーマの正はマイグレーション。`docs/schema.sql` は全体像の参照用）
- `line/client.js` に `SEND_MODE`（dry_run / test / live）の3段階ガードを実装
- Webhook 署名検証、`follow` / `unfollow` イベント処理
- `notify/slack.js`

**完了条件**: テストアカウントを友だち追加すると `customers` にレコードが作られ、ブロックすると `is_blocked` が立つ。`SEND_MODE=dry_run` では実際に送信されないことをテストで確認できる。

---

## Phase 2 — 顧客の紐付け（LIFF）

ここが全機能の土台。**急がず確実に。**

- LIFF 登録フォーム（氏名・電話番号・誕生日・配信同意）
- ID トークン検証をサーバ側で実装（なりすまし防止）
- 電話番号の正規化と既存顧客との突合ロジック
- あいさつメッセージからの LIFF 導線、リッチメニュー
- 突合失敗時の Slack 通知

**完了条件**: 友だち追加 → LIFF で登録 → `customers.line_user_id` と `birthday` が正しく入る一連の流れが通る。既存顧客の電話番号で登録した場合に、新規作成ではなく既存レコードが更新される。

---

## Phase 3 — 前々日確認

最初に作る配信ジョブ。ここで運用が回るかを検証する。

- `jobs/runner.js`（cron 登録、ジョブ共通のエラーハンドリングとサマリ通知）
- `jobs/preReminder.js`
- Flex Message テンプレート
- postback 処理（ok / change）と、change 時の Slack 通知
- `scripts/run-job.js --job=preReminder --dry-run`

**完了条件**: テストデータで2日後の予約を作り、dry-run で対象者が正しく1件だけ抽出される。同じジョブを2回実行しても `dedupe_key` で2通目が送られない。

**ここで一度止めて、実店舗で1〜2週間運用する。** 紐付け率と反応率が見えてから残りを作るほうが、文面もタイミングも精度が上がる。

---

## Phase 4 — 来店7日後フォロー

- `jobs/afterVisit.js`
- 自由入力返信の Claude Haiku 分類（good / concern / question）
- concern・question の Slack 通知

**完了条件**: 分類が JSON パース失敗した場合に `concern` へフォールバックすることをテストで確認。

---

## Phase 5 — 誕生日・休眠フォロー

- `jobs/birthday.js`（2/29 の扱いを含む）
- `jobs/dormant.js`
- 日次上限（`DORMANT_DAILY_LIMIT`）による分散送信
- opt_out の postback 処理
- 月間通数の残数チェックと閾値警告

**完了条件**: **本番投入前に、休眠フォローの初回対象件数を必ず dry-run で確認する。** 想定より桁違いに多ければ日次上限を調整する。

---

## Phase 6 — 予約データの取り込み（完了）

`reservations` への書き込みは `src/reservations/service.js` のアダプタ層に集約し、
**3つの入口すべてを実装済み**。上流が変わってもここから下は作り直さない。

1. **自作の予約フォーム（LIFF）** — 顧客がリッチメニューから希望日時をリクエスト。
   店舗の承認（`requested` → `confirmed`）で確定する
2. **外部予約 SaaS 連携** — `POST /api/import/reservations` に `external_id` で冪等 upsert。
   EPARK など CSV しかない場合は `scripts/import-csv.js` で変換して投入
3. **スタッフ手入力** — 店舗管理画面（`/mock/`）から登録

来店実績は、管理画面の「来店」ボタンまたは取り込み API の `status: "visited"` で更新し、
`customers.last_visit_at` へ自動反映される（Phase 4・5 のジョブはこれを起点に動く）。

詳細は [import-api.md](import-api.md) を参照。

---

## 本番投入前チェックリスト

コードは揃っているため、残るは設定と運用判断のみ。

- [ ] 運用中の LINE 公式アカウントへの接続 → [switch-account.md](switch-account.md)
      （Webhook を他ツールが使っていないかを最初に確認する。userId はプロバイダーごとに
      変わるため、紐付けを引き継ぐなら**同一プロバイダー**が必要）
- [ ] 既存顧客台帳（氏名・電話番号・誕生日）の初期投入。LIFF 登録時の突合率に直結する
- [ ] メニューの登録（管理画面）。デモ投入は `node scripts/seed-menus.js`
- [ ] リッチメニュー画像（2500×843px）の用意と `scripts/setup-richmenu.js` の実行
- [ ] 誕生日クーポンの作成と `BIRTHDAY_COUPON_URL` の設定
- [ ] `SEND_MODE=dry_run` で数日運用し、毎朝のジョブ実行サマリを確認
- [ ] **休眠フォローの初回対象件数を dry-run で確認**（一斉送信で通数を使い切らないため必須）
- [ ] `SEND_MODE=live` へ切り替え（`.env` に書かず実行時に渡す）
- [ ] DB の日次バックアップ自動化

---

## Phase 7 — マルチテナント化（任意・未着手）

他店舗へ横展開する場合。

- `tenants` テーブルと全テーブルへの `tenant_id` 付与
- テナントごとの LINE チャネル資格情報の保管
- 文面テンプレートのテナント別カスタマイズ

現状は1店舗構成のため未着手。横展開が決まった時点で着手する。
