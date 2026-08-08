// app_settings テーブルの読み書き。実行時に変更される設定はここを経由する。

export const SETTING_KEYS = {
  staffLineGroupId: 'staff_line_group_id',
  // 日次ジョブの実行結果。Push すると通数を消費するため、保存しておいて
  // グループから「配信結果」と聞かれたときに応答メッセージ（無料）で返す
  lastJobSummary: 'last_job_summary',
};

export function createSettings({ pool }) {
  async function get(key) {
    const { rows } = await pool.query(`SELECT value FROM app_settings WHERE key = $1`, [key]);
    return rows[0]?.value ?? null;
  }

  async function set(key, value) {
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, value]
    );
  }

  async function remove(key) {
    await pool.query(`DELETE FROM app_settings WHERE key = $1`, [key]);
  }

  return { get, set, remove };
}
