# 本番の LINE 公式アカウントへの切り替え

テスト用チャネルで動かしていたシステムを、お店の本番アカウントに繋ぎ替える手順。

**この作業で一番危険なのは、切り替えた直後に本物のお客様へ配信が飛ぶこと。**
そのため `SEND_MODE` は最後まで `live` にしない。順番を飛ばさないこと。

---

## 0. 前提の確認

LINE の **userId はプロバイダーごとに別の値**になる。本番アカウントがテスト用と別プロバイダーなら、
DB に入っている `line_user_id` は**すべて無効**になり、お客様には再度 LIFF から登録してもらう必要がある。
テストデータしか入っていない今のうちに切り替えるのが一番安い。

必要なもの:

- 本番アカウントのプロバイダーで作成された **Messaging API チャネル**
- 同じプロバイダーの **LINE Login チャネル配下の LIFF アプリ**（顧客情報フォーム・予約フォーム用）
- LINE Official Account Manager の管理権限

---

## 1. 資格情報を取得する

LINE Developers で本番アカウントのプロバイダーを開く。

| 取得するもの | 場所 | 入る変数 |
|---|---|---|
| チャネルアクセストークン（長期） | Messaging API チャネル → Messaging API 設定 | `LINE_CHANNEL_ACCESS_TOKEN` |
| チャネルシークレット（32文字） | Messaging API チャネル → チャネル基本設定 | `LINE_CHANNEL_SECRET` |
| LIFF ID | LINE Login チャネル → LIFF タブ | `LIFF_ID` |

**よくある間違い**: `LINE_CHANNEL_SECRET` に LINE Login チャネルのシークレットを入れると、
Webhook の署名検証が必ず 401 になる。Messaging API チャネル側の値を使う。

LIFF アプリの設定:

- サイズ: **Full**
- エンドポイント URL: `https://<ドメイン>/liff/`
- スコープ: `profile` を有効化

---

## 2. VM の `.env` を書き換える

```bash
cd cocotte-vert
cp .env .env.test.bak      # テスト用の値を残しておく（戻せるように）
vi .env
```

書き換えるのは3つ。**`SEND_MODE` は `dry_run` のままにする。**

```
LINE_CHANNEL_ACCESS_TOKEN=（本番の長期トークン）
LINE_CHANNEL_SECRET=（本番のチャネルシークレット）
LIFF_ID=（本番の LIFF ID）
SEND_MODE=dry_run
```

反映:

```bash
docker compose --profile standalone up -d
curl -s https://<ドメイン>/health
```

---

## 3. 古い紐付けを消す

**この手順を飛ばすと、切り替え後に不可解な動作をする。**

```bash
docker compose exec db psql -U postgres -d cocotte_vert
```

```sql
-- 旧チャネルの userId は本番では通用しないため外す。
-- 顧客台帳（氏名・電話番号・誕生日）はそのまま残るので、LIFF 登録時に再度突合される
UPDATE customers SET line_user_id = NULL, is_blocked = false;

-- スタッフ通知先のグループ ID も旧チャネル基準。消さないと Bot を新しく招待しても
-- 「既に別のグループが設定済み」と判定され、通知先が切り替わらない
DELETE FROM app_settings WHERE key = 'staff_line_group_id';
```

`message_logs` は消さなくてよい。`dedupe_key` は予約 ID 基準なので、テストで送った予約に
本番で再送されないという副作用はあるが、対象がテストデータなら実害はない。
気になるなら `DELETE FROM message_logs;` で消してよい（送信履歴が消えるだけ）。

---

## 4. LINE 側の設定

### Official Account Manager（設定 → 応答設定）

- 応答モード: **Bot**
- Webhook: **オン**
- 応答メッセージ: **オフ**（オンのままだと自動応答が二重に返る）
- あいさつメッセージ: オフ（本システムが `follow` イベントで送るため）

ここが未設定だと Webhook が飛ばず、原因究明で必ず時間を溶かす。

### LINE Developers（Messaging API 設定）

- Webhook URL: `https://<ドメイン>/webhook`
- Webhook の利用: **オン**
- 「検証」ボタンで成功すること

---

## 5. 動作確認（`dry_run` のまま）

1. **自分で本番アカウントを友だち追加する。** `customers` にレコードが作られ、
   あいさつメッセージが返ることを確認
2. LIFF から自分の情報を登録し、`line_user_id` が入ることを確認
3. スタッフ用グループに Bot を招待。「このグループをスタッフ通知先として設定しました」と返れば成功
4. グループで **「配信結果」** と発言して応答が返ることを確認

```sql
SELECT id, name, line_user_id IS NOT NULL AS linked FROM customers ORDER BY id DESC LIMIT 5;
```

---

## 6. テスト送信で文面を確認する

自分の userId を控えて `.env` に入れる（**旧チャネルの値は使えない**ので取り直す）。

```bash
docker compose logs app | grep 'follow'   # 友だち追加時のログから確認できる
```

```
SEND_MODE=test
TEST_LINE_USER_ID=（新チャネルでの自分の userId）
```

```bash
docker compose --profile standalone up -d
```

管理画面（`/admin/`）の「配信メッセージのテスト送信」で4種類とも自分に届くことを確認する。
宛先は `TEST_LINE_USER_ID` に固定されるため、この段階でもお客様には届かない。

---

## 7. リッチメニューを貼り直す

`LIFF_ID` が変わったので、旧アカウントのリッチメニューは使えない。

```bash
docker compose exec app node scripts/setup-richmenu.js --image=/path/to/richmenu.png
```

左「ご予約」／右「お客様情報」で登録される。実際にタップしてフォームが開くことを確認する。

---

## 8. 本番送信へ切り替える

**ここから先はお客様に実際に届く。**

- [ ] 既存顧客台帳（氏名・電話番号・誕生日）を投入済みか
- [ ] メニューを登録済みか（`node scripts/seed-menus.js` またはメニュー管理）
- [ ] 誕生日クーポンを作成し `BIRTHDAY_COUPON_URL` を設定したか
- [ ] **休眠フォローの初回対象件数を dry-run で確認したか**（一斉送信で通数を使い切らないため必須）

```bash
# .env には書かない。実行時に明示的に渡す
docker compose --profile standalone up -d
docker compose exec -e SEND_MODE=live app node scripts/run-job.js --job=preReminder
```

常時 `live` で運用する場合のみ `.env` の `SEND_MODE` を書き換える。
その際は**必ず休眠フォローの対象件数を確認してから**にすること。

---

## 戻し方

問題が起きたら `.env` を元に戻すだけでテスト用チャネルに戻る。

```bash
cp .env.test.bak .env
docker compose --profile standalone up -d
```

ただし `customers.line_user_id` は手順3で消しているため、テスト側の紐付けは復活しない。
