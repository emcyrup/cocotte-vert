// 店舗管理画面からの予約 CSV 取り込み（EPARK など）。
//
// これまでコマンドからしか取り込めなかったものを、画面のボタンでできるようにする。
// 列の対応づけ（どの列が予約番号か、など）は実物の CSV が届くまで確定しないため、
// 画面から編集して app_settings に保存する。上流の書式が変わってもデプロイは要らない。
//
// 文字コードの変換はブラウザ側で行い、ここへは文字列になった CSV が届く。
// Shift_JIS のバイト列をそのまま JSON に載せると壊れるため。
import express from 'express';
import { convertCsv, DEFAULT_MAPPING, MAPPING_FIELDS, STATUS_VALUES } from '../import/csv.js';
import { SETTING_KEYS } from '../settings.js';

// 一度に扱う上限。CSV 本文は JSON で受けるため、本文サイズの上限（index.js）とあわせて効かせる
const MAX_ROWS = 2000;
export const MAX_CSV_BYTES = 5 * 1024 * 1024;
// 画面に出す見本の行数。全件返すと重くなるうえ、見ても分からない
const PREVIEW_ROWS = 5;

/** 画面から送られたマッピングを、そのまま信用せずに整える */
export function sanitizeMapping(input) {
  const known = new Set(MAPPING_FIELDS.map((f) => f.key));
  const columns = {};
  for (const [key, value] of Object.entries(input?.columns ?? {})) {
    if (known.has(key) && typeof value === 'string' && value.trim()) columns[key] = value.trim();
  }
  const statusMap = {};
  for (const [word, value] of Object.entries(input?.statusMap ?? {})) {
    if (typeof word === 'string' && word.trim() && STATUS_VALUES.includes(value)) {
      statusMap[word.trim()] = value;
    }
  }
  const defaultStatus = STATUS_VALUES.includes(input?.defaultStatus) ? input.defaultStatus : 'confirmed';
  return {
    encoding: input?.encoding === 'utf-8' ? 'utf-8' : 'shift_jis',
    externalIdPrefix: typeof input?.externalIdPrefix === 'string' ? input.externalIdPrefix.slice(0, 32) : '',
    columns,
    statusMap,
    defaultStatus,
  };
}

export function createAdminImportRouter({ reservationService, settings, slack }) {
  const router = express.Router();

  async function loadMapping() {
    const stored = await settings.get(SETTING_KEYS.importMapping).catch(() => null);
    if (!stored) return DEFAULT_MAPPING;
    try {
      return sanitizeMapping(JSON.parse(stored));
    } catch {
      // 壊れた設定で取り込みごと止めない。既定に戻して画面から直してもらう
      console.error('[import] 保存済みの列対応づけを読めませんでした。既定を使います');
      return DEFAULT_MAPPING;
    }
  }

  /** 画面が対応づけを組み立てるための材料 */
  router.get('/mapping', async (_req, res, next) => {
    try {
      res.json({ mapping: await loadMapping(), fields: MAPPING_FIELDS, statusValues: STATUS_VALUES });
    } catch (err) {
      next(err);
    }
  });

  router.put('/mapping', async (req, res, next) => {
    try {
      const mapping = sanitizeMapping(req.body?.mapping);
      await settings.set(SETTING_KEYS.importMapping, JSON.stringify(mapping));
      res.json({ ok: true, mapping });
    } catch (err) {
      next(err);
    }
  });

  /**
   * 取り込む前の下見。ヘッダ行・件数・変換できない行を返す。
   * body: { csv: string, mapping?: object }
   */
  router.post('/preview', async (req, res, next) => {
    try {
      const csv = req.body?.csv;
      if (typeof csv !== 'string' || !csv.trim()) return res.status(400).json({ error: 'csv_required' });

      const mapping = req.body?.mapping ? sanitizeMapping(req.body.mapping) : await loadMapping();
      const { header, items, problems, statusWords } = convertCsv(csv, mapping);
      res.json({
        header,
        mapping,
        total: items.length + problems.length,
        ready: items.length,
        problems: problems.slice(0, 50),
        problemCount: problems.length,
        // 見覚えのない文言が既定に落ちていないか、画面で確かめてもらう
        statusWords,
        sample: items.slice(0, PREVIEW_ROWS),
        tooMany: items.length > MAX_ROWS ? MAX_ROWS : null,
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * 取り込みの実行。external_id で冪等に upsert するので、同じ CSV を二度流しても増えない。
   * body: { csv: string, mapping?: object }
   */
  router.post('/reservations', async (req, res, next) => {
    try {
      const csv = req.body?.csv;
      if (typeof csv !== 'string' || !csv.trim()) return res.status(400).json({ error: 'csv_required' });

      const mapping = req.body?.mapping ? sanitizeMapping(req.body.mapping) : await loadMapping();
      const { items, problems } = convertCsv(csv, mapping);
      if (items.length === 0) {
        return res.status(400).json({ error: 'no_rows', problems: problems.slice(0, 50) });
      }
      if (items.length > MAX_ROWS) {
        return res.status(400).json({ error: 'too_many', max: MAX_ROWS, count: items.length });
      }

      const results = [];
      // 1件のエラーで全体を止めない。行ごとに結果を返す
      for (const item of items) {
        try {
          const result = await reservationService.upsertExternal({
            externalId: item.external_id,
            customerName: item.customer_name,
            phone: item.phone,
            birthday: item.birthday,
            menu: item.menu,
            staffName: item.staff_name,
            reservedAt: item.reserved_at,
            status: item.status,
          });
          results.push({ external_id: item.external_id, ...result });
        } catch (err) {
          results.push({ external_id: item.external_id, ok: false, error: err.message });
        }
      }

      const summary = {
        total: results.length,
        created: results.filter((r) => r.ok && r.created).length,
        updated: results.filter((r) => r.ok && !r.created).length,
        failed: results.filter((r) => !r.ok).length,
        skipped: problems.length,
      };
      console.log(
        `[import] 画面から取り込み: 全${summary.total} 新規${summary.created} 更新${summary.updated} ` +
          `失敗${summary.failed} 取り込めず${summary.skipped}`
      );
      // 取り込みは件数が多く、画面を閉じたあとに気付けないため、結果を通知に残す
      if (summary.failed > 0 || problems.length > 0) {
        await slack.notify(
          `:warning: 予約CSVの取り込み: ${summary.failed}件が失敗、${problems.length}件が取り込めませんでした` +
            `（全${summary.total + problems.length}件中）。画面の結果をご確認ください。`
        );
      }
      res.json({
        summary,
        problems: problems.slice(0, 50),
        failures: results.filter((r) => !r.ok).slice(0, 50),
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
