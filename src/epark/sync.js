// EPARK 側の枠を自動で閉じる／開け直す。
//
// 作業の一覧は `reservations/externalBlock.js` がそのまま使える。手でチェックを
// 付けていたものを、ここが代わりに消し込む。**画面のチェックリストは残す**：
// 自動化が失敗した分はそこに残り続けるので、気付ける状態が保たれる。
//
// 3段階のガード（EPARK_MODE）。既定は off で、明示しない限り EPARK を触らない。
//   off     … 何もしない。チェックリストだけで運用する
//   dry_run … ログインして枠の状態を読むだけ。閉じない（駆動部の検証用）
//   live    … 実際に閉じる／開け直す
//
// **書いたら必ず読み直す。** 読み直して意図どおりになっていたときだけ済みにする。
// 書けていないのに済みにすると、チェックリストからも消えて誰も気付けなくなる。
//
// 閉じるときは、EPARK の院内メモに「誰のご予約か」を添える（`details.js`）。
// 相手の顧客台帳は触らないので、間違っていても消せる範囲に収まる。

import { isValidDriver } from './driver.js';
import { slotOf, slotLabel } from './slot.js';
import { detailsText } from './details.js';

const EMPTY = { total: 0, done: 0, dryRun: 0, failed: 0, errors: [] };

export function createEparkSync({ externalBlocks, driver, slack, config }) {
  const mode = config?.epark?.mode || 'off';
  // EPARK_DETAILS=off で、これまでどおりの無名の仮受付に戻せる
  const withDetails = config?.epark?.details !== false;

  /**
   * 未反映の作業を片付ける。
   * 1件の失敗で他を止めない（他の枠は閉じられるため）。失敗は Slack へまとめて出す。
   */
  async function run() {
    if (mode === 'off') return { ...EMPTY, skippedReason: 'off' };
    if (!isValidDriver(driver)) {
      // 契約を満たさない駆動部で live に入ると、閉じたつもりのまま消し込む恐れがある
      await slack.notifyError('EPARK 自動反映', new Error('駆動部が読み直しに対応していません'));
      return { ...EMPTY, skippedReason: 'invalid_driver' };
    }

    const { toBlock, toRelease } = await externalBlocks.listPending();
    const work = [
      ...toBlock.map((row) => ({ row, action: 'close' })),
      ...toRelease.map((row) => ({ row, action: 'open' })),
    ];
    const summary = { total: work.length, done: 0, dryRun: 0, failed: 0, errors: [] };
    if (work.length === 0) return summary;

    await driver.open();
    try {
      // 枠の刻みは相手の受付表しだい（実物は1時間）。駆動部が知っている値に合わせる
      const slotMinutes = driver.slotMinutes ?? 60;
      for (const { row, action } of work) {
        // 開け直すのは「自分が実際に閉じた枠」だけ。スタッフが手で止めた枠は触らない
        const slot = slotOf(row, { slotMinutes, action: action === 'open' ? 'release' : 'close' });
        try {
          if (mode === 'dry_run') {
            // 何を閉じるはずだったかと、いまの EPARK 側の状態を並べて出す。
            // 駆動部が正しく読めているかは、この2つを突き合わせて判断する
            const closed = await driver.isSlotClosed(slot);
            console.log(`[epark:dry_run] ${action} ${slotLabel(slot)} 現在=${closed ? '閉' : '開'}`);
            summary.dryRun += 1;
            continue;
          }

          let touched = null;
          if (action === 'close') {
            // EPARK の受付表に「誰のご予約か」を出す。作った文字列は氏名・電話番号を
            // 含むので、ログにも Slack にも載せない（渡すのは駆動部にだけ）
            const details = withDetails ? detailsText(row) : null;
            ({ closed: touched } = await driver.closeSlot(slot, details));
          } else await driver.openSlot(slot);

          // ここが要。書けたと信じずに読み直す
          const closed = await driver.isSlotClosed(slot);
          const wanted = action === 'close';
          if (closed !== wanted) {
            throw new Error(`反映を確認できません（期待=${wanted ? '閉' : '開'} 実際=${closed ? '閉' : '開'}）`);
          }

          const result = await externalBlocks.setDone({
            id: slot.reservationId,
            done: true,
            cells: touched,
          });
          if (!result.ok) throw new Error(`記録できません: ${result.error}`);
          console.log(`[epark] ${action} ${slotLabel(slot)}`);
          summary.done += 1;
        } catch (err) {
          // 済みにしないので、この予約はチェックリストに残る（手で閉じれば消し込める）
          console.error(`[epark] ${action} 失敗 ${slotLabel(slot)}: ${err.message}`);
          summary.failed += 1;
          summary.errors.push({ reservationId: slot.reservationId, action, message: err.message });
        }
      }
    } finally {
      // ログインしたまま落ちるとセッションが残るため、失敗しても必ず閉じる
      await driver.close().catch((err) => console.error(`[epark] 後始末に失敗: ${err.message}`));
    }

    if (summary.failed > 0) {
      // 顧客は内部 id でのみ参照する（氏名・電話番号は通知に含めない）
      const detail = summary.errors
        .slice(0, 10)
        .map((e) => `res=${e.reservationId} ${e.action}: ${e.message}`)
        .join('\n');
      await slack.notify(
        `:warning: *EPARK 自動反映に失敗した枠があります*（${summary.failed}/${summary.total}件）\n` +
          `管理画面の「EPARK未反映」に残っています。手で閉じてチェックを付けてください。\n` +
          `\`\`\`${detail}\`\`\``
      );
    }
    return summary;
  }

  return { run, mode };
}
