// 定額コース（保育コース）のマスタ投入。新しい店舗の立ち上げで使う。
// 使い方: node scripts/seed-plans.js
// 同じ名前があれば飛ばすので、何度実行しても増えない。

const PLANS = [
  { name: '保育コース 月4回', monthlyQuota: 4, carryOverMonths: 1, sortOrder: 1 },
  { name: '保育コース 月8回', monthlyQuota: 8, carryOverMonths: 1, sortOrder: 2 },
];

const { pool } = await import('../src/db/pool.js');

const added = [];
for (const p of PLANS) {
  const { rows } = await pool.query(`SELECT 1 FROM plans WHERE name = $1`, [p.name]);
  if (rows.length > 0) continue;
  await pool.query(
    `INSERT INTO plans (name, monthly_quota, carry_over_months, sort_order) VALUES ($1, $2, $3, $4)`,
    [p.name, p.monthlyQuota, p.carryOverMonths, p.sortOrder]
  );
  added.push(p.name);
}
console.log(added.length ? `[seed-plans] 追加 ${added.length}件: ${added.join('、')}` : '[seed-plans] 追加なし（すべて登録済み）');
await pool.end();
