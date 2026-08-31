-- スタッフが画面から追加できる配信ルール（追加リマインド）。
--
-- R1〜R4 は条件も文面もコードに固定だが、こちらは「来店から○日後」「予約の○日前」の
-- 条件・文面・配信時刻をスタッフが決める。判定と送信は R1〜R4 と同じ日次の仕組みに乗せ、
-- dedupe_key・SEND_MODE・opt_out の守りもそのまま効かせる。

CREATE TABLE IF NOT EXISTS custom_reminders (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  -- after_visit = 来店から○日後 / before_reservation = 予約の○日前
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('after_visit', 'before_reservation')),
  days        INTEGER NOT NULL CHECK (days BETWEEN 1 AND 365),
  -- 配信時刻（JST の時）。深夜・早朝に送らない範囲は DB でも守る
  send_hour   INTEGER NOT NULL DEFAULT 10 CHECK (send_hour BETWEEN 9 AND 20),
  message     TEXT NOT NULL,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- message_logs の job_type に追加リマインド用の値を足す
ALTER TYPE job_type ADD VALUE IF NOT EXISTS 'custom';
