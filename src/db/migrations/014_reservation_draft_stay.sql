-- お泊まり（宿泊）の退室日。
--
-- 入室は reserved_at が持つ。退室は「日付」だけを持たせる。お迎えの時刻は当日の
-- 都合で動くうえ、決まっていない段階で時刻を入れると、決まった予定に見えてしまうため。
-- 泊数は退室日と入室日の差から導けるので、列としては持たない。

ALTER TABLE reservation_drafts ADD COLUMN IF NOT EXISTS checkout_date DATE;
