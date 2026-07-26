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

## テスト

```bash
npm test
```

## デプロイ（インターネット公開）

VPS / EC2 + Docker Compose、または Render での公開手順を [docs/deploy.md](docs/deploy.md) にまとめている。

## Webhook のローカル確認

cloudflared / ngrok でトンネルを張り、LINE Developers の Webhook URL に
`https://<トンネル>/webhook` を設定する。署名検証に失敗したリクエストは 401 で拒否される。
