// リマインド配信の店舗設定（管理画面から個別／一括で ON/OFF できる）。
//
// 設定は app_settings に JSON 1行で持つ。行が無い状態＝これまでどおり全部 ON にしてあるので、
// 既存環境を移行しても挙動は変わらない。
import { SETTING_KEYS } from './settings.js';
import { DEFAULT_BODY as PRE_BODY } from './line/messages/preReminder.js';
import { DEFAULT_BODY as AFTER_BODY } from './line/messages/afterVisit.js';
import { DEFAULT_BODY as DORMANT_BODY } from './line/messages/dormant.js';
import { DEFAULT_BODY as BIRTHDAY_BODY } from './line/messages/birthday.js';

// 画面の R番号と日次ジョブ名の対応。画面・API・ジョブで同じ並びを使う
export const REMINDER_JOBS = [
  { key: 'preReminder', id: 'R1', label: '前々日確認' },
  { key: 'afterVisit', id: 'R2', label: '来店7日後フォロー' },
  { key: 'dormant', id: 'R3', label: '休眠フォロー' },
  { key: 'birthday', id: 'R4', label: '誕生日メッセージ' },
];

const KEYS = REMINDER_JOBS.map((j) => j.key);

// 配信時刻に選べる範囲（JST の時）。深夜・早朝に送らない守りはここで効かせる。
// 既定はこれまでどおり 10 時
export const SEND_HOUR_MIN = 9;
export const SEND_HOUR_MAX = 20;
export const DEFAULT_SEND_HOUR = 10;

/** 9〜20 の整数だけを通す。それ以外は理由付きで弾く */
export function validSendHour(v) {
  return Number.isInteger(v) && v >= SEND_HOUR_MIN && v <= SEND_HOUR_MAX;
}

// 4種それぞれの既定の本文。コード側が正で、語彙は test/messageCopy.test.js が見張る。
// 画面はこれを初期値として出し、書き換えたぶんだけが app_settings に載る
export const DEFAULT_TEXTS = {
  preReminder: PRE_BODY,
  afterVisit: AFTER_BODY,
  dormant: DORMANT_BODY,
  birthday: BIRTHDAY_BODY,
};

const MAX_TEXT = 500;

export function createReminderSettings({ settings }) {
  /** 4種すべての ON/OFF を返す（未設定は ON） */
  async function getAll() {
    let stored = {};
    if (settings) {
      const raw = await settings.get(SETTING_KEYS.remindersEnabled).catch(() => null);
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') stored = parsed;
        } catch {
          // 壊れた値で配信が止まる方が害が大きいため、読めないときは全 ON として扱う
          console.error('[reminders] 設定を読めませんでした。全 ON として扱います');
        }
      }
    }
    return Object.fromEntries(KEYS.map((k) => [k, stored[k] !== false]));
  }

  /** 日次ジョブ側の判定。設定を読めないときは止めない（配信が黙って止まる方が危ない） */
  async function isEnabled(key) {
    if (!KEYS.includes(key)) return true;
    try {
      return (await getAll())[key];
    } catch (err) {
      console.error(`[reminders] 設定の取得に失敗したため実行します: ${err.message}`);
      return true;
    }
  }

  /** 与えられたぶんだけ更新して、更新後の全体を返す（一括 ON/OFF もこれ1本で行う） */
  async function update(patch) {
    if (!settings) throw new Error('設定を保存できません');
    const next = { ...(await getAll()) };
    for (const [k, v] of Object.entries(patch ?? {})) {
      if (!KEYS.includes(k)) throw new Error(`未知のリマインドです: ${k}`);
      if (typeof v !== 'boolean') throw new Error(`ON/OFF は真偽値で指定してください: ${k}`);
      next[k] = v;
    }
    await settings.set(SETTING_KEYS.remindersEnabled, JSON.stringify(next));
    return next;
  }

  /** 4種すべての配信時刻（JST の時）を返す。未設定・読めないときは従来どおり 10 時 */
  async function getHours() {
    let stored = {};
    if (settings) {
      const raw = await settings.get(SETTING_KEYS.remindersHours).catch(() => null);
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') stored = parsed;
        } catch {
          // 壊れた値で配信が止まるより、従来の時刻で送るほうが害が小さい
          console.error('[reminders] 配信時刻を読めませんでした。10時として扱います');
        }
      }
    }
    return Object.fromEntries(
      KEYS.map((k) => [k, validSendHour(stored[k]) ? stored[k] : DEFAULT_SEND_HOUR])
    );
  }

  /** 変えるぶんだけ受け取り、更新後の全体を返す。範囲外の時刻は保存前に弾く */
  async function updateHours(patch) {
    if (!settings) throw new Error('設定を保存できません');
    const next = { ...(await getHours()) };
    for (const [k, v] of Object.entries(patch ?? {})) {
      if (!KEYS.includes(k)) throw new Error(`未知のリマインドです: ${k}`);
      if (!validSendHour(v)) {
        throw new Error(`配信時刻は ${SEND_HOUR_MIN}〜${SEND_HOUR_MAX} 時で指定してください: ${k}`);
      }
      next[k] = v;
    }
    await settings.set(SETTING_KEYS.remindersHours, JSON.stringify(next));
    return next;
  }

  /**
   * 本文の上書きを返す（{ジョブ名: 文字列 or null}。null は既定の文面のまま）。
   * 読めないときは全部既定に倒す ── 壊れた設定で配信が止まるより、元の文面で送るほうが害が小さい
   */
  async function getTexts() {
    let stored = {};
    if (settings) {
      const raw = await settings.get(SETTING_KEYS.reminderTexts).catch(() => null);
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') stored = parsed;
        } catch {
          console.error('[reminders] 文面の設定を読めませんでした。既定の文面で送ります');
        }
      }
    }
    return Object.fromEntries(
      KEYS.map((k) => [k, typeof stored[k] === 'string' && stored[k].trim() ? stored[k] : null])
    );
  }

  /**
   * 本文の上書きを更新する。空文字・null を渡すと上書きを消して既定の文面に戻す
   * （「元に戻す」を消し忘れなく実現するため、リセットも同じ入口にする）
   */
  async function updateTexts(patch) {
    if (!settings) throw new Error('設定を保存できません');
    const next = { ...(await getTexts()) };
    for (const [k, v] of Object.entries(patch ?? {})) {
      if (!KEYS.includes(k)) throw new Error(`未知のリマインドです: ${k}`);
      if (v === null || String(v).trim() === '') {
        next[k] = null;
        continue;
      }
      if (typeof v !== 'string') throw new Error(`文面は文字列で指定してください: ${k}`);
      const text = v.trim();
      if (text.length > MAX_TEXT) throw new Error(`文面は${MAX_TEXT}文字までです: ${k}`);
      next[k] = text;
    }
    // 既定のままのぶん（null）は保存しない。行を消せば必ず既定に戻る形を保つ
    const toStore = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== null));
    await settings.set(SETTING_KEYS.reminderTexts, JSON.stringify(toStore));
    return next;
  }

  return { getAll, isEnabled, update, getHours, updateHours, getTexts, updateTexts };
}

/**
 * お客様ごとのリマインド ON/OFF。
 *
 * 店舗全体の設定（上の createReminderSettings）とは別枠で、両方 ON のときだけ送られる。
 * 判定はジョブ側の SQL に埋め込んである（対象者の抽出と同じクエリで済ませるため）。
 * ここは画面から読み書きするための入口。
 */
export function createCustomerReminders({ pool }) {
  async function get(customerId) {
    const { rows } = await pool.query(
      `SELECT job, enabled FROM customer_reminder_settings WHERE customer_id = $1`,
      [customerId]
    );
    const stored = Object.fromEntries(rows.map((r) => [r.job, r.enabled]));
    return Object.fromEntries(KEYS.map((k) => [k, stored[k] !== false]));
  }

  /** 変えるぶんだけ受け取り、更新後の全体を返す */
  async function update(customerId, patch) {
    const entries = Object.entries(patch ?? {});
    for (const [k, v] of entries) {
      if (!KEYS.includes(k)) throw new Error(`未知のリマインドです: ${k}`);
      if (typeof v !== 'boolean') throw new Error(`ON/OFF は真偽値で指定してください: ${k}`);
    }
    for (const [job, enabled] of entries) {
      await pool.query(
        `INSERT INTO customer_reminder_settings (customer_id, job, enabled)
         VALUES ($1, $2, $3)
         ON CONFLICT (customer_id, job)
         DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
        [customerId, job, enabled]
      );
    }
    return get(customerId);
  }

  return { get, update };
}
