// デモ用メニューの投入。予約フォームの動作確認をすぐ始められるようにする。
// 料金は犬種によって変わるため、メニューには持たせずご来店時にご案内する想定。
// 使い方: docker compose exec app node scripts/seed-menus.js
//
// 同名のメニューが既にあれば飛ばすため、何度実行しても重複しない。
// 本番のメニューは管理画面から登録・編集する想定。

export const DEMO_MENUS = [
  { name: 'シャンプーコース', durationMinutes: 60 },
  { name: 'シャンプー＆カットコース', durationMinutes: 120 },
  { name: '部分カット（顔・足まわり）', durationMinutes: 30 },
  { name: '爪切り・耳掃除', durationMinutes: 15 },
  { name: '保育コース', durationMinutes: 480 },
  { name: '一時預かり', durationMinutes: 60 },
  { name: '宿泊（レギュラーコース）', durationMinutes: null },
  { name: '宿泊（保育コース）', durationMinutes: null },
];

export async function seedMenus(pool, menus = DEMO_MENUS) {
  const result = { added: [], skipped: [] };
  // 表示順は配列の並びに合わせる。既存分の後ろに続ける
  const { rows: base } = await pool.query(
    `SELECT COALESCE(max(sort_order) + 1, 0) AS next FROM menus`
  );
  let sortOrder = Number(base[0].next);

  for (const menu of menus) {
    const { rows } = await pool.query(
      `INSERT INTO menus (name, duration_minutes, sort_order)
       SELECT $1, $2, $3
       WHERE NOT EXISTS (SELECT 1 FROM menus WHERE name = $1)
       RETURNING id`,
      [menu.name, menu.durationMinutes, sortOrder]
    );
    if (rows.length > 0) {
      result.added.push(menu.name);
      sortOrder++;
    } else {
      result.skipped.push(menu.name);
    }
  }
  return result;
}

async function main() {
  const { pool } = await import('../src/db/pool.js');
  const result = await seedMenus(pool);
  console.log(`[seed-menus] 追加 ${result.added.length}件: ${result.added.join('、') || 'なし'}`);
  if (result.skipped.length > 0) {
    console.log(`[seed-menus] 既存のためスキップ ${result.skipped.length}件: ${result.skipped.join('、')}`);
  }
  await pool.end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
