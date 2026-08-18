// スタッフ用グループのメンバー一覧が取れるアカウントかを、実際に呼んで確かめる。
//
// グループ全員の LINE userId を取る API は、アカウント種別によって使えないことがある。
// ドキュメントを読むだけでは自店のアカウントで使えるか分からないため、一度叩いて確認する。
//
// 使い方（VM 上で）:
//   docker compose exec app node scripts/check-group-members.js
//
// 出力に LINE userId・氏名は含めない（顧客・スタッフの識別子はログに残さない方針のため）。

import { pool } from '../src/db/pool.js';
import { loadConfig } from '../src/config.js';
import { createLineClient } from '../src/line/client.js';
import { createSettings, SETTING_KEYS } from '../src/settings.js';

const config = loadConfig();
const settings = createSettings({ pool });
const lineClient = createLineClient({ config, pool });

async function main() {
  const groupId =
    (await settings.get(SETTING_KEYS.staffLineGroupId).catch(() => null)) ??
    config.staffLineGroupId ??
    null;

  if (!groupId) {
    console.log('スタッフ用グループが未設定です。Bot をグループに招待してから実行してください。');
    return;
  }
  console.log('スタッフ用グループ: 設定済み');

  // 人数はアカウント種別を問わず取れるはず。ここで落ちるなら、種別ではなく
  // トークンかグループ側の問題。切り分けのため結果を覚えておく
  let countOk = false;
  try {
    console.log(`グループの人数: ${await lineClient.getGroupMemberCount(groupId)}人`);
    countOk = true;
  } catch (err) {
    console.log(`グループの人数: 取得できません（${err.message}）`);
  }

  const result = await lineClient.getGroupMemberIds(groupId);
  if (!result.ok) {
    console.log('');
    console.log('▼ メンバー一覧の取得: 使えません');
    console.log(`   HTTP ${result.status ?? '不明'}: ${result.message}`);
    if (!countOk) {
      // 人数すら取れていない。アカウント種別ではなく、手前で失敗している
      console.log('   人数も取れていないため、原因はアカウント種別ではありません。');
      console.log('   アクセストークンか、Bot がこのグループにいるかをご確認ください。');
    } else {
      console.log('   人数は取れているので、アクセストークンとグループの設定は正常です。');
      console.log('   このアカウントでは、グループ全員の userId を取る API を使えません。');
      console.log('   → 管理画面にメンバー一覧を出す案は使えません。');
      console.log('   → グループにボタンを置いて本人にタップしてもらう方法をお使いください。');
    }
    return;
  }

  console.log('');
  console.log('▼ メンバー一覧の取得: 使えます');
  console.log(`   取得できた人数: ${result.memberIds.length}人`);

  // 連携済みかどうかの内訳だけを出す。userId そのものは出さない
  const { rows } = await pool.query(
    `SELECT count(*) FILTER (WHERE line_user_id = ANY($1::text[])) AS linked
       FROM staff WHERE active = true`,
    [result.memberIds]
  );
  const linked = Number(rows[0].linked);
  console.log(`   うち、スタッフとして連携済み: ${linked}人`);
  console.log(`   まだ連携していない人: ${result.memberIds.length - linked}人`);
  console.log('   （連携していない人には、ご家族や業者の方など、スタッフ以外も含まれます）');
}

main()
  .catch((err) => {
    console.error(`確認に失敗しました: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
