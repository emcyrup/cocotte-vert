// ジョブ共通処理: cron 登録・実行サマリの Slack 通知・異常終了の捕捉。
// 個々の対象者のエラーはジョブ側で捕捉する前提（1件の失敗で他を止めない）。
// ここで捕捉するのはジョブ全体の異常（DB 接続断など）。
import cron from 'node-cron';

export function createJobRunner({ slack }) {
  /**
   * ジョブを1つ実行し、サマリを Slack へ送る。
   * ジョブ関数は { total, sent, dryRun, skipped, failed, errors } を返す規約とする。
   */
  async function runJob(name, jobFn) {
    const startedAt = Date.now();
    console.log(`[job:${name}] 開始`);
    try {
      const summary = await jobFn();
      const sec = ((Date.now() - startedAt) / 1000).toFixed(1);
      const line =
        `対象 ${summary.total} / 送信 ${summary.sent} / dry_run ${summary.dryRun}` +
        ` / スキップ ${summary.skipped} / 失敗 ${summary.failed}（${sec}秒）`;
      console.log(`[job:${name}] 完了 ${line}`);
      await slack.notify(`:package: ジョブ実行結果 *${name}*\n${line}`);
      if (summary.failed > 0 && summary.errors?.length) {
        // 顧客は内部 id でのみ参照する（氏名・LINE userId を通知に含めない）
        const detail = summary.errors
          .slice(0, 10)
          .map((e) => `customer=${e.customerId}: ${e.message}`)
          .join('\n');
        await slack.notify(`:warning: *${name}* 失敗詳細（最大10件）\n\`\`\`${detail}\`\`\``);
      }
      return summary;
    } catch (err) {
      console.error(`[job:${name}] 異常終了: ${err.message}`);
      await slack.notifyError(`ジョブ異常終了: ${name}`, err);
      return null;
    }
  }

  /**
   * 毎日 10:00 JST に全ジョブを直列実行する。
   * 配信時刻は 10:00 JST 固定（深夜・早朝の送信は絶対に行わない）。
   * @param {Record<string, () => Promise<object>>} jobs
   */
  function scheduleDaily(jobs) {
    return cron.schedule(
      '0 10 * * *',
      async () => {
        for (const [name, jobFn] of Object.entries(jobs)) {
          await runJob(name, jobFn);
        }
      },
      { timezone: 'Asia/Tokyo' }
    );
  }

  return { runJob, scheduleDaily };
}
