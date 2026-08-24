-- EPARK など外部の予約サイトで「枠を閉じた」ことの記録。
--
-- 予約の入口はこのアプリを正とするが、EPARK からもお客様が予約できる状態が続く。
-- こちらで入った予約の時間帯を EPARK 側で閉じておかないと、同じ枠に別のお客様が入る。
-- EPARK には外部から書き込む口が無いため、閉じる作業はスタッフの手作業になる。
-- その「やった／まだ」を持たせて、入れ忘れを画面で気付けるようにする。
--
-- 取り消した予約では逆に「閉じた枠を開け直す」必要がある。開け直しの済み・未済も
-- 同じ列で表せるよう、値は「いつ閉じたか」ではなく「いまの反映が済んでいるか」を表す
-- 時刻として扱う（状態が変わったら NULL に戻し、再び作業対象として並べる）。

ALTER TABLE reservations ADD COLUMN IF NOT EXISTS external_blocked_at TIMESTAMPTZ;

-- 未反映の抽出は「これから来る予約」に対して毎回走る。件数は少ないが、
-- 予約一覧の描画と同時に引くため索引を用意しておく
CREATE INDEX IF NOT EXISTS reservations_external_pending_idx
  ON reservations (reserved_at)
  WHERE external_id IS NULL AND external_blocked_at IS NULL;
