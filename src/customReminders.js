// スタッフが画面から追加できる配信ルール（追加リマインド）の読み書き。
//
// R1〜R4 は条件も文面もコードに固定してあるが、こちらは条件・文面・時刻をスタッフが決める。
// そのぶん入口の検証を厳しくする ── 保存できた設定は必ず送れる設定、にしておかないと、
// 配信の日になって初めて壊れていると分かる（そのときはもうお客様の目の前）。
import { validSendHour, SEND_HOUR_MIN, SEND_HOUR_MAX } from './reminders.js';

export const TRIGGER_TYPES = {
  after_visit: { label: '来店から◯日後', min: 1, max: 365 },
  before_reservation: { label: '予約の◯日前', min: 1, max: 30 },
};

const MAX_NAME = 50;
// LINE のテキスト上限は 5000 だが、リマインドは読み切れる長さに抑える
const MAX_MESSAGE = 1000;

/**
 * 入力を検証して保存できる形にする。だめなら日本語の理由で投げる（画面にそのまま出す）。
 * @returns {{name: string, triggerType: string, days: number, sendHour: number,
 *            message: string, enabled: boolean}}
 */
export function validateRule(input = {}) {
  const name = String(input.name ?? '').trim();
  if (!name) throw new Error('名前を入れてください');
  if (name.length > MAX_NAME) throw new Error(`名前は${MAX_NAME}文字までです`);

  const triggerType = input.triggerType;
  const spec = TRIGGER_TYPES[triggerType];
  if (!spec) throw new Error('タイミングの種類を選んでください');

  const days = Number(input.days);
  if (!Number.isInteger(days) || days < spec.min || days > spec.max) {
    throw new Error(`日数は ${spec.min}〜${spec.max} で指定してください（${spec.label}）`);
  }

  const sendHour = Number(input.sendHour ?? 10);
  if (!validSendHour(sendHour)) {
    throw new Error(`配信時刻は ${SEND_HOUR_MIN}〜${SEND_HOUR_MAX} 時で指定してください`);
  }

  const message = String(input.message ?? '').trim();
  if (!message) throw new Error('文面を入れてください');
  if (message.length > MAX_MESSAGE) throw new Error(`文面は${MAX_MESSAGE}文字までです`);

  const enabled = input.enabled === undefined ? true : input.enabled;
  if (typeof enabled !== 'boolean') throw new Error('ON/OFF は真偽値で指定してください');

  return { name, triggerType, days, sendHour, message, enabled };
}

const toRow = (r) => ({
  id: r.id,
  name: r.name,
  triggerType: r.trigger_type,
  days: r.days,
  sendHour: r.send_hour,
  message: r.message,
  enabled: r.enabled,
  createdAt: r.created_at,
});

export function createCustomReminders({ pool }) {
  async function list() {
    const { rows } = await pool.query(
      `SELECT id, name, trigger_type, days, send_hour, message, enabled, created_at
       FROM custom_reminders ORDER BY id`
    );
    return rows.map(toRow);
  }

  async function create(input) {
    const v = validateRule(input);
    const { rows } = await pool.query(
      `INSERT INTO custom_reminders (name, trigger_type, days, send_hour, message, enabled)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, trigger_type, days, send_hour, message, enabled, created_at`,
      [v.name, v.triggerType, v.days, v.sendHour, v.message, v.enabled]
    );
    return toRow(rows[0]);
  }

  async function update(id, input) {
    const { rows: current } = await pool.query(
      `SELECT id, name, trigger_type, days, send_hour, message, enabled
       FROM custom_reminders WHERE id = $1`,
      [id]
    );
    if (current.length === 0) throw new Error('not_found');
    // 変えるぶんだけ受け取り、全体としてもう一度検証する（部分更新で壊れた形にしない）
    const v = validateRule({ ...toRow(current[0]), ...input });
    const { rows } = await pool.query(
      `UPDATE custom_reminders
       SET name = $2, trigger_type = $3, days = $4, send_hour = $5, message = $6,
           enabled = $7, updated_at = now()
       WHERE id = $1
       RETURNING id, name, trigger_type, days, send_hour, message, enabled, created_at`,
      [id, v.name, v.triggerType, v.days, v.sendHour, v.message, v.enabled]
    );
    return toRow(rows[0]);
  }

  async function remove(id) {
    const { rowCount } = await pool.query(`DELETE FROM custom_reminders WHERE id = $1`, [id]);
    if (rowCount === 0) throw new Error('not_found');
  }

  /** この時刻に動かすルールがあるか（毎時の起床時に、無駄に走らせないための判定） */
  async function hasRulesAt(hour) {
    const { rows } = await pool.query(
      `SELECT 1 FROM custom_reminders WHERE enabled = true AND send_hour = $1 LIMIT 1`,
      [hour]
    );
    return rows.length > 0;
  }

  return { list, create, update, remove, hasRulesAt };
}
