-- 予約の所要時間。
--
-- これまではコース名から所要時間を引いていたが、カレンダーで枠を作るときに
-- 「この予約だけ長め／短め」を指定できなかった。予約ごとに持てるようにする。
--
-- NULL はこれまでどおり「コースの所要時間に従う」。既存行は触らない。
ALTER TABLE reservations
  ADD COLUMN duration_minutes INT CHECK (duration_minutes > 0 AND duration_minutes <= 1440);
