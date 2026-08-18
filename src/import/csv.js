// 予約 CSV の解釈。EPARK など「CSV エクスポートしかない」予約システムとの連携で使う。
//
// 列名の対応はマッピング（JSON）で吸収するため、上流の CSV が変わってもここは書き換えない。
// 店舗管理画面（画面から取り込む）と scripts/import-csv.js（コマンドから取り込む）の
// 両方がこれを使う。変換の結果が場所によって変わらないよう、実装は必ずここ1本に保つ。

// 実物の CSV が届くまでの仮置き。画面の「列の対応づけ」で上書きできる
export const DEFAULT_MAPPING = {
  encoding: 'shift_jis',
  externalIdPrefix: 'epark-',
  columns: {
    external_id: '予約番号',
    customer_name: '氏名',
    phone: '電話番号',
    reserved_date: '予約日',
    reserved_time: '予約時間',
    menu: 'メニュー',
    staff_name: '担当者',
    status: 'ステータス',
  },
  statusMap: {
    予約確定: 'confirmed',
    確定: 'confirmed',
    来店済み: 'visited',
    来店: 'visited',
    キャンセル: 'cancelled',
    無断キャンセル: 'no_show',
  },
  defaultStatus: 'confirmed',
};

// 対応づけできる項目。画面のプルダウンもこの順に並べる
export const MAPPING_FIELDS = [
  { key: 'external_id', label: '予約番号', required: true, note: '取り込みの目印。同じ番号は上書きされる' },
  { key: 'customer_name', label: 'お名前', required: true },
  { key: 'phone', label: '電話番号', required: true, note: 'お客様の突合に使う' },
  { key: 'reserved_date', label: '予約日', required: false, note: '日付と時刻が分かれている場合' },
  { key: 'reserved_time', label: '予約時刻', required: false },
  { key: 'reserved_datetime', label: '予約日時', required: false, note: '日付と時刻が1列の場合はこちら' },
  { key: 'menu', label: 'コース', required: false },
  { key: 'staff_name', label: '担当', required: false },
  { key: 'birthday', label: '誕生日', required: false },
  { key: 'status', label: '状態', required: false, note: '未指定なら「確定」として取り込む' },
];

export const STATUS_VALUES = ['confirmed', 'visited', 'cancelled', 'no_show'];

/** 引用符・カンマ・改行（CRLF/LF）対応の素朴な CSV パーサ */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}

/** 「2026/08/01」「2026-08-01」+「14:00」を ISO(+09:00) にする */
export function toJstIso(dateStr, timeStr) {
  const d = (dateStr ?? '').trim().replaceAll('/', '-');
  const m = d.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return null;
  const t = (timeStr ?? '').trim().match(/^(\d{1,2}):(\d{2})/) ?? ['', '0', '00'];
  const pad = (n) => String(n).padStart(2, '0');
  return `${m[1]}-${pad(m[2])}-${pad(m[3])}T${pad(t[1])}:${t[2]}:00+09:00`;
}

/** 1行を取り込み API の形式に変換する */
export function convertRow(row, header, mapping) {
  const col = (name) => {
    const key = mapping.columns[name];
    if (!key) return null;
    const idx = header.indexOf(key);
    return idx >= 0 ? (row[idx] ?? '').trim() : null;
  };

  const reservedAt = mapping.columns.reserved_datetime
    ? toJstIso(...(col('reserved_datetime') ?? '').split(/\s+/))
    : toJstIso(col('reserved_date'), col('reserved_time'));

  const rawStatus = col('status');
  const status = (rawStatus && mapping.statusMap?.[rawStatus]) || mapping.defaultStatus || 'confirmed';

  // 予約番号が空のまま接頭辞だけを付けると、空の行がすべて同じ目印になり
  // 1件の予約を上書きし合ってしまう。取れないときは null のままにする
  const externalId = col('external_id');

  return {
    external_id: externalId ? `${mapping.externalIdPrefix ?? ''}${externalId}` : null,
    customer_name: col('customer_name'),
    phone: col('phone'),
    birthday: col('birthday') || undefined,
    menu: col('menu') || undefined,
    staff_name: col('staff_name') || undefined,
    reserved_at: reservedAt,
    status,
  };
}

/**
 * 取り込む前に、この行が通るかどうかを見る。
 * 上流の CSV は必ずしもきれいではないため、落ちる行を先に画面へ出して気付けるようにする。
 */
export function rowProblem(item) {
  if (!item.external_id) return '予約番号がありません';
  if (!item.customer_name) return 'お名前がありません';
  // 電話番号はお客様の突合キー。無いと別のお客様に紐づきかねない
  if (!item.phone) return '電話番号がありません';
  if (!item.reserved_at) return '予約日時を読み取れません';
  if (!STATUS_VALUES.includes(item.status)) return `状態「${item.status}」が分かりません`;
  return null;
}

/**
 * CSV 全体を取り込み API の形式へ。ヘッダ行と、行ごとの変換結果・問題点を返す。
 *
 * statusWords は、その CSV に実際に出てきた状態の文言と、それをどう解釈したか。
 * 見覚えのない文言は既定（多くは「確定」）に落ちるため、キャンセルを確定として
 * 取り込んでしまう事故が起きうる。気付けるよう、解釈の結果を必ず外へ出す。
 *
 * @returns {{header: string[], items: object[], problems: Array<{line: number, reason: string}>,
 *            statusWords: Array<{word: string, status: string, known: boolean, count: number}>}}
 */
export function convertCsv(text, mapping) {
  const rows = parseCsv(text);
  if (rows.length < 2) return { header: rows[0] ?? [], items: [], problems: [], statusWords: [] };

  const [header, ...dataRows] = rows;
  const statusIdx = mapping.columns.status ? header.indexOf(mapping.columns.status) : -1;
  const seen = new Map();
  const items = [];
  const problems = [];

  dataRows.forEach((row, i) => {
    if (statusIdx >= 0) {
      const word = (row[statusIdx] ?? '').trim();
      if (word) {
        const known = Object.hasOwn(mapping.statusMap ?? {}, word);
        const entry = seen.get(word)
          ?? { word, status: known ? mapping.statusMap[word] : (mapping.defaultStatus || 'confirmed'), known, count: 0 };
        entry.count += 1;
        seen.set(word, entry);
      }
    }
    const item = convertRow(row, header, mapping);
    const reason = rowProblem(item);
    // 見出し行を 1 とした行番号で返す（画面で CSV と突き合わせるため）
    if (reason) problems.push({ line: i + 2, reason });
    else items.push(item);
  });

  return { header, items, problems, statusWords: [...seen.values()] };
}
