# 予約取り込み API

外部予約システム（予約 SaaS・CSV エクスポート等）から `reservations` へ予約を取り込むための API。
`external_id` をキーに**冪等に upsert** するため、同じデータを何度送っても二重登録されない。

## 認証

`.env` の `INGEST_API_TOKEN` に設定したトークンを Bearer で送る（未設定の場合 API は 503 で無効）。

```
Authorization: Bearer <INGEST_API_TOKEN>
```

## エンドポイント

```
POST /api/import/reservations
Content-Type: application/json
```

### リクエスト

```json
{
  "reservations": [
    {
      "external_id": "hotpepper-20260801-001",
      "customer_name": "山田 花子",
      "phone": "090-1234-5678",
      "birthday": "1990-04-01",
      "menu": "シャンプー＆カットコース",
      "staff_name": "佐藤",
      "reserved_at": "2026-08-01T14:00:00+09:00",
      "status": "confirmed"
    }
  ]
}
```

| フィールド | 必須 | 説明 |
|---|---|---|
| `external_id` | ○ | 外部システム側の予約 ID。冪等キー |
| `customer_name` | ○ | 顧客名。突合は電話番号で行い、名前は新規作成時のみ使用 |
| `phone` | ○ | 顧客の電話番号（表記ゆれは自動正規化） |
| `birthday` | - | `YYYY-MM-DD`。新規顧客作成時のみ反映 |
| `menu` | - | メニュー名 |
| `staff_name` | - | 担当者名。存在しなければ staff に自動作成 |
| `reserved_at` | ○ | ISO 8601。タイムゾーン付き推奨（`+09:00`） |
| `status` | - | `confirmed`（デフォルト） / `cancelled` / `visited` / `no_show` |

- 1リクエスト最大 500 件
- 顧客は電話番号（正規化済み）で既存台帳と突合。ヒットしなければ新規作成（LINE 連携には触らない）
- `status: "visited"` で送ると `customers.last_visit_at` も更新される（来店実績の取り込みに使う）
- 新規の確定予約は Slack に通知される（更新では通知しない）

### レスポンス

```json
{
  "summary": { "total": 1, "created": 1, "updated": 0, "failed": 0 },
  "results": [
    { "external_id": "hotpepper-20260801-001", "ok": true, "reservationId": 12, "customerId": 3, "created": true }
  ]
}
```

行単位でエラーを返すため、1件の不正データで全体は失敗しない。

## 使用例（curl）

```bash
curl -X POST https://<ドメイン>/api/import/reservations \
  -H "Authorization: Bearer $INGEST_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d @reservations.json
```

## EPARK 側の枠を閉じる（このアプリ → EPARK）

取り込みとは**逆向き**の話。予約の入口をこのアプリへ寄せても、EPARK からお客様が予約できる
状態は続く。こちらで入った予約の時間帯を EPARK 側で閉じておかないと、埋まっている時間に
リクエストが来て、お客様に断りを入れることになる。

> EPARK の予約は**店舗の承認制**なので、閉じ忘れても二重予約そのものは起きない
> （下記「[EPARK 管理画面の自動操作](#epark-管理画面の自動操作rpa)」を参照）。
> 閉じるのは、無駄なリクエストと断りの手間を減らすため。

**EPARK には外部から予約枠を操作する口が無いため、既定では手作業。**
アプリ側が持つのは「やった／まだ」だけで、自動で何かを送るわけではない。
ブラウザ操作による自動化は下記のとおり進行中で、**その場合もこのチェックリストは安全網として残す**。

### 画面

`/mock/#resv`（**予約管理**）の「**EPARK未反映**」カード。2種類の作業が並ぶ。

| 見出し | 対象 | やること |
| --- | --- | --- |
| EPARK側で枠を閉じる | `status='confirmed'` かつ `external_blocked_at IS NULL` | EPARK の同じ時間の枠を閉じる |
| EPARK側で枠を開け直す（取消・見送り分） | `status='cancelled'` かつ `external_blocked_at IS NOT NULL` | 閉じた枠を開け直す |

チェックを付けると一覧から消える。**EPARK 側を閉じる前に付けると閉じ忘れに気付けない**ので、
スタッフ向け手順書（[staff-manual.md](staff-manual.md)）でも念を押している。

### 仕組み

- `reservations.external_blocked_at TIMESTAMPTZ` … 「いつ閉じたか」ではなく
  **いまの反映が済んでいるか**を表す。状態が変わったら NULL に戻し、再び作業対象として並べる
- `external_id` が付いた予約（EPARK から取り込んだもの）は**対象外**。もとから EPARK 側にある
- `reserved_at > now()` のものだけ出す。過ぎた予約の枠を今から閉じても意味がない
- **日時を変えたら未反映へ戻す**（`updateManual`）。前の時間の枠を閉じたままでは意味がないため、
  開け直しと閉じ直しの両方が作業として出てくる
- 済み・未済を記録するとき、**どちらの向きの作業かは SQL の中で予約の状態から決める**。
  一覧を開いたあとに状態が変われば押した時点の意味が変わるため、画面の申告は使わない

## EPARK 管理画面の自動操作（RPA）

**EPARK の協力は得られなかった**（2026-08）。API・iCal・予約枠の一括休止のいずれも使えない。
残る手は、EPARK の管理画面をブラウザ操作で自動化することだけになる。

### 前提：EPARK の予約は店舗の承認制

EPARK からの予約は**店舗が受付確認をして初めて確定する**。つまり枠を閉じ忘れても
**二重予約そのものは起きない**（重なったら断ればよい）。自動化の目的は事故防止ではなく、

- 埋まっている時間にリクエストが来て、お客様に断りを入れる手間と体験の悪さを減らす
- 枠を閉じる／開け直す手作業をなくす

の2点。**この前提は失敗時の許容度を決める**。自動化が静かに壊れても、悪化するのは
「EPARK の空きが実態とずれる」ところまでで、今の運用に戻るだけ。取り返しのつかない
事故にはならないので、RPA を試す価値がある。

### 安全の作り方

自動化で一番怖いのは「閉じたつもりで閉じていない」状態。自動化されている前提で
誰も見なくなるため、チェックリストより危険になる。ここでは3つで受ける。

**① 3段階のガード（`EPARK_MODE`）。** 既定は `off`。明示しない限り EPARK を一切触らない。

| 値 | 動き |
| --- | --- |
| `off`（既定） | 何もしない。画面のチェックリストだけで運用する |
| `dry_run` | ログインして枠の状態を読むだけ。閉じない。駆動部の検証はここで済ませる |
| `live` | 実際に閉じる／開け直す。`.env` には書かず実行時に渡す |

**② 書いたら必ず読み直す。** `driver.isSlotClosed(slot)` で画面から読み直し、意図どおりに
なっていたときだけ済みにする。読み直せない駆動部は `isValidDriver` で弾き、実行させない。

**③ 失敗はチェックリストに残す。** 済みにしないので画面の「EPARK未反映」に残り、
Slack にも通知が飛ぶ。**自動化は手作業の置き換えであって、安全網は残したまま**にする。

### 構成

| ファイル | 役割 |
| --- | --- |
| `src/reservations/externalBlock.js` | 作業の一覧（手作業と共通。自動化はこれを消し込むだけ） |
| `src/epark/slot.js` | 予約から「閉じる枠」を切り出す。日付・時刻は JST で確定させる |
| `src/epark/profile.js` | **押す場所の設定**（セレクタと手順）と、その検証 |
| `src/epark/browserDriver.js` | ブラウザ操作。「どう押すか」だけを持ち、「どこを押すか」は持たない |
| `src/epark/driver.js` | 駆動部の契約と、何もしない駆動部 |
| `src/epark/sync.js` | 一覧を消化し、読み直して確認し、失敗を残す |
| `scripts/epark-probe.js` | 管理画面を**見る**だけの道具（何も書き換えない） |
| `scripts/run-epark-sync.js` | 手動実行（`--dry-run` で安全側に落とせる） |

### 押す場所はコードに書かない

実物の画面を見ないとセレクタは決まらない。決め打ちにすると画面が変わるたびにデプロイが要る。
**CSV の列の対応づけと同じ理由**で、相手の都合で変わるものは設定として外に出す。

`config/epark-profile.json`（見本は `config/epark-profile.example.json`）:

```json
{
  "loginUrl": "https://.../admin/login",
  "login": { "user": "#loginId", "password": "#password",
             "submit": "button[type=\"submit\"]", "ready": "#dashboard" },
  "dayUrl": "https://.../admin/schedule?date={date}",
  "slot": ".slot[data-time=\"{time}\"]",
  "closedWhen": ".is-closed",
  "close": [ { "click": "{slot} a.edit" },
             { "click": "button:has-text(\"この枠を閉じる\")" },
             { "waitFor": "#dashboard" } ],
  "open":  [ { "click": "{slot} a.edit" },
             { "click": "button:has-text(\"この枠を開ける\")" },
             { "waitFor": "#dashboard" } ]
}
```

- セレクタに `{slot}` / `{date}` / `{time}` を埋め込める
- 1手は `click` / `fill` / `select` / `waitFor` のどれか1つ
- `closedWhen` は `slot` に継ぎ足す。枠そのものに印が付くなら `".is-closed"`、
  中の要素で表すなら `" .badge-closed"` のように先頭に空白を置く（子孫セレクタ）
- **ログイン情報はここに書かない。** `.env` の `EPARK_USER` / `EPARK_PASSWORD` を使う
- ファイルは `.gitignore` 済み（URL に店舗の識別子が入るため）

`validateProfile` が起動前に検証する。とくに `dayUrl` に `{date}`、`slot` に `{time}` が
入っていないものは弾く。**時刻が入らない設定はその日の枠を全部閉じてしまう**ため。

### 実物の画面を調べる

セレクタを埋めるには実物が要る。`scripts/epark-probe.js` は**見るだけ**で、何も書き換えない。

```bash
node --env-file-if-exists=.env scripts/epark-probe.js
node --env-file-if-exists=.env scripts/epark-probe.js --url='https://.../schedule?date=2026-09-01'
node --env-file-if-exists=.env scripts/epark-probe.js --headed --keep=180   # 手元の PC で手動操作
```

`epark-probe/` にスクリーンショットと HTML が落ちる。二要素認証があるときは `--headed` で
手で通す。**HTML にお客様の氏名・電話番号が含まれることがある**ので、共有前に必ず中身を
確認する（`.gitignore` 済み）。

### 確かめたこと

実物が見られないため、**作り物の管理画面**（`test/fixtures/eparkFake.js`）を立てて、
実際の Chromium で駆動部を動かしている。実物に合わせるのは設定であって、この流れは変わらない。

- ログイン → 日付の画面 → 枠を押す → **読み直して閉じたことを確かめる**
- 閉じた枠を開け直せる
- **枠が見つからないときは例外にする**（「見つからない＝閉じている」と読むと、日付違いや
  画面変更を成功と誤読して消し込んでしまう）
- ログインできなければ画面を操作せずに止まる
- パスワードを例外の文言に出さない

ブラウザが無い環境（CI など）では、この5件は自動で飛ぶ。

### playwright の扱い

`optionalDependencies` に入れ、**使うときだけ動的に読む**。EPARK を使わない環境や、
本番サーバーにブラウザを置けない環境でもアプリは起動する。

`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` を Dockerfile・デプロイ・CI に設定してあるため、
**ブラウザ本体（数百MB）は落ちない**（`node_modules` は約 44MB 増える）。
実際に動かす環境でだけ `npx playwright install chromium` を実行する。

### 移設先での制約

本番の AWS は **sudo なし・Docker なし**。Chromium はシステムライブラリを要求するため、
そのままでは動かない可能性が高い。回避策は2つ。

1. **インフラ会社に依存パッケージの導入を一度だけ依頼する**（`client_max_body_size` などと同じ扱い）
2. **GitHub Actions の定期実行から動かす**。ランナーには一式が揃っている。
   アプリの API 経由で一覧を取り、消し込みを返す形にすればサーバー側に何も足さずに済む。
   定期実行は数分〜数十分ずれることがあるが、枠を閉じる用途では許容範囲

### 残り

- `config/epark-profile.json` を実物の画面から埋める（`epark-probe.js` の出力待ち）
- 二要素認証があるかの確認。あればセッションの持ち回しを考える必要がある
- 実行場所の決定（アプリサーバーの cron か、GitHub Actions か）
- `dry_run` で読み取りだけ検証 → 問題なければ `live`

---

## CSV からの取り込み（EPARK など）

EPARK のように公開 API がない予約システムは、予約の CSV をエクスポートして取り込む。
**店舗管理画面から取り込むのが通常の手順**。コマンドからも同じことができる（下記）。

### 店舗管理画面から取り込む

`/mock/#resv`（**予約管理**）の「**予約データの取り込み**」カード。

1. CSV ファイルを選ぶ（文字コードは自動判定。Shift_JIS / UTF-8 を明示することもできる）
2. **列の対応づけ**を選ぶ。プルダウンには実際の CSV の見出しが並ぶ
3. **状態の読み替え**を確かめる。CSV に出てきた文言と、それをどう扱うかが件数つきで出る
4. 読み取り結果（取り込める件数・取り込めない行）を見て「**取り込む**」

- 「**この対応づけを保存**」を押すと `app_settings` に残り、次回から同じ内容で読み取る。
  **上流の書式が変わってもデプロイは要らない**
- `external_id`（予約番号）で冪等に upsert する。同じファイルを二度取り込んでも増えない
- 予約番号・お名前・電話番号・予約日時のどれかが欠けている行は取り込まず、
  **CSV の行番号と理由**を画面に出す
- 1回の上限は 2000 行 / 5MB

**状態の読み替えは必ず確認すること。** 見覚えのない文言は既定（多くは「確定」）に落ちる。
キャンセルを確定として取り込むと、来ないお客様へ前々日確認が飛ぶ。当てはまりの無い文言には
「要確認」を出しているので、その場で選び直す。

文字コードの変換はブラウザ側で行い、サーバへは文字列にしてから送る
（Shift_JIS のバイト列をそのまま JSON に載せると壊れるため）。

### コマンドから取り込む

`scripts/import-csv.js`。列名の対応は `scripts/mappings/*.json` で調整する。
変換そのものは画面と同じ `src/import/csv.js` を使うため、結果は一致する。

```bash
# 変換結果の確認（API には送らない）
node scripts/import-csv.js --file=epark.csv --map=scripts/mappings/epark.json --dry-run

# 取り込み実行（VM 上なら）
docker compose exec app node scripts/import-csv.js \
  --file=/tmp/epark.csv --map=scripts/mappings/epark.json --token=$INGEST_API_TOKEN
```

- `scripts/mappings/epark.json` の `columns` を、実際の CSV のヘッダ行に合わせて修正する
- 文字コードは `encoding`（`shift_jis` / `utf-8`）で指定
- ステータスの文言 →`confirmed`/`visited`/`cancelled`/`no_show` の対応は `statusMap` で定義
- 営業終了後に当日分（来店済み）を再エクスポート→再実行すれば、来店実績も反映される（冪等）

## 運用パターン

- **予約 SaaS に Webhook がある場合**: Webhook 受信側でこの形式に変換して POST する
- **CSV エクスポートしかない場合**: CSV → JSON 変換スクリプトを cron で回して定期 POST する
- **来店実績の反映**: 営業終了後に当日分を `status: "visited"` で再送すれば、来店7日後フォロー・休眠判定が回り出す

# LINE からの予約リクエスト（LIFF 予約フォーム）

顧客はリッチメニューの「ご予約」から予約フォームを開き、希望日時をリクエストできる。

- **承認制**: 顧客が送信した予約は `requested`（承認待ち）で作られる。配信ジョブは `confirmed` のみが対象なので、未承認の予約に前々日確認は飛ばない
- **顧客の特定**: LINE の ID トークンをサーバー側で検証して行う。未登録（LIFF 登録前）の顧客には登録フォームへの導線を出し、リクエストは受け付けない
- **メニュー**: 管理画面の「メニュー管理」で登録したものが選択肢になる。予約側には名称をコピーして保存するため、後でメニュー名を変えても過去の予約表示は変わらない
- **スタッフの操作**: 管理画面の予約一覧で「承認」または「見送り」を押す。承認待ちの予約は期間指定に関わらず常に一覧の先頭に表示される
- **顧客への通知**: 承認・見送りのどちらでも顧客へ Push で結果を伝える（1件につき通数を1消費）
- **連投防止**: 承認待ちが3件たまっている顧客は追加でリクエストできない

動作確認用のデモメニューを一括投入する（同名は飛ばすため何度実行しても安全）:

```bash
docker compose exec app node scripts/seed-menus.js
```

リッチメニューの設定（左：ご予約／右：お客様情報）:

```bash
docker compose exec app node scripts/setup-richmenu.js --image=/path/to/richmenu.png
```

「お客様情報」は登録用と変更用を兼ねる。未登録の顧客には登録フォームとして、
登録済みの顧客には現在の内容を入れた**確認・変更フォーム**として開き、
氏名・電話番号・誕生日・配信同意をその場で直せる。

# 管理画面

`https://<ドメイン>/mock/` でスタッフ向けの店舗管理画面が使える（旧 `/admin/` はリダイレクト）（Basic 認証。`.env` の `ADMIN_USER` / `ADMIN_PASSWORD`）。

- 予約一覧（期間指定。画面の最下部）と、来店 / 取消 / 無断キャンセルの操作（来店で `last_visit_at` が自動更新）
- LINE からの予約リクエストの **承認 / 見送り**（承認待ちは常に一覧の先頭に表示）
- 新規予約の手入力（顧客検索 → 日時・メニュー・担当を指定）
- 電話予約など LINE 未連携の顧客登録、スタッフ追加
- **メニュー管理**（予約フォームの選択肢になる。並び順・所要時間・有効/無効）
- 前々日確認に「このまま伺います」と回答済みの予約には「本人確認済」バッジが付く
- **EPARK未反映**（EPARK 側で枠を閉じる／開け直す作業の残り。上記「EPARK 側の枠を閉じる」）

**配信メッセージのテスト送信**は別画面（`/mock/#test`）にある。顧客へ送りうる7種類
（前々日確認・来店7日後・休眠・誕生日・予約の受付/確定/見送り）を即時に自分へ送れる。
宛先は必ず `TEST_LINE_USER_ID` に固定され、`dry_run` では標準出力のみ、
`live` では誤爆防止のため実行を拒否する。`message_logs` に記録しないので
`dedupe_key` を消費せず、本番の配信には影響しない。
