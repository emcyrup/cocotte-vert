-- 投稿先に X と WordPress を許す。
--
-- 008 の CHECK が ('instagram', 'threads') のままだったため、WordPress へ投稿しようと
-- すると DB が行の挿入を弾き、画面には「internal error」だけが出ていた。
-- アプリ側（src/sns/platforms.js）に投稿先を足すときは、この制約も一緒に更新すること。

ALTER TABLE sns_posts
  DROP CONSTRAINT IF EXISTS sns_posts_platform_check;

ALTER TABLE sns_posts
  ADD CONSTRAINT sns_posts_platform_check
  CHECK (platform IN ('instagram', 'threads', 'x', 'wordpress'));
