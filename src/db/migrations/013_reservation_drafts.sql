-- 公式LINE から送られた予約の「下書き」。
--
-- 送られた文章は AI が読み取っているため、そのまま reservations に入れると読み違いが
-- お客様の予定として残ってしまう。いったんここへ置き、スタッフが内容を見て
-- 「登録」を押したときだけ本予約にする。
--
-- 顧客が特定できていない下書きもある（該当者なしで新規登録する場合、
-- 同名が複数いてどの方か選んでもらう場合）。そのため customer_id は NULL を許す。

CREATE TYPE reservation_draft_status AS ENUM ('pending', 'registered', 'cancelled');

CREATE TABLE reservation_drafts (
  id                  BIGSERIAL PRIMARY KEY,
  -- 送られてきた場所。ここ以外からは確定させない（別のトークのボタンで動かされないため）
  source_type         TEXT NOT NULL,
  source_id           TEXT NOT NULL,
  customer_id         BIGINT REFERENCES customers(id) ON DELETE CASCADE,
  -- 該当者がいないときに新規作成する内容。電話番号はハイフン除去済み
  new_customer_name   TEXT,
  new_customer_phone  TEXT,
  staff_id            BIGINT REFERENCES staff(id),
  menu                TEXT,
  reserved_at         TIMESTAMPTZ NOT NULL,
  duration_minutes    INT,
  raw_text            TEXT NOT NULL,
  status              reservation_draft_status NOT NULL DEFAULT 'pending',
  reservation_id      BIGINT REFERENCES reservations(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at          TIMESTAMPTZ
);

CREATE INDEX reservation_drafts_source_idx
  ON reservation_drafts (source_type, source_id) WHERE status = 'pending';
