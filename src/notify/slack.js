// スタッフ通知は Slack Incoming Webhook のみ（LINE グループ Push は通数を消費するため使わない）。
// 通知失敗で本処理を落とさない。ここでは投げっぱなしにせずログだけ残す。

export function createSlackNotifier({ webhookUrl, fetchFn = fetch }) {
  async function notify(text) {
    try {
      const res = await fetchFn(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        console.error(`[slack] 通知失敗: HTTP ${res.status}`);
        return false;
      }
      return true;
    } catch (err) {
      console.error(`[slack] 通知失敗: ${err.message}`);
      return false;
    }
  }

  /** ジョブ異常終了など、エラー内容とスタックトレースを送る */
  async function notifyError(context, err) {
    const stack = err?.stack || String(err);
    return notify(`:rotating_light: *${context}*\n\`\`\`${stack.slice(0, 2800)}\`\`\``);
  }

  return { notify, notifyError };
}
