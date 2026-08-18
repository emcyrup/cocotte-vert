// 予約 CSV を取り込み API（POST /api/import/reservations）へ流すスクリプト。
// EPARK など「CSV エクスポートしかない」予約システムとの連携用。
// 列名の対応はマッピングファイル（JSON）で吸収するため、上流が変わってもここは書き換えない。
//
// 使い方:
//   node scripts/import-csv.js --file=reservations.csv --map=scripts/mappings/epark.json \
//     [--url=http://127.0.0.1:3000] [--token=$INGEST_API_TOKEN] [--dry-run]
//
// --dry-run は API に送らず、変換結果の JSON を表示するだけ（マッピング調整用）
import { readFile } from 'node:fs/promises';
import { parseCsv, toJstIso, convertRow } from '../src/import/csv.js';

// 画面からの取り込みと結果が食い違わないよう、変換そのものは src/import/csv.js に集約した。
// 既存の呼び出し（テスト・手順書）を壊さないよう、ここからも同じものを出す
export { parseCsv, toJstIso, convertRow };

function getArg(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

async function main() {
  const filePath = getArg('file');
  const mapPath = getArg('map');
  const baseUrl = getArg('url', 'http://127.0.0.1:3000');
  const token = getArg('token', process.env.INGEST_API_TOKEN ?? '');
  const dryRun = process.argv.includes('--dry-run');

  if (!filePath || !mapPath) {
    console.error(
      '使い方: node scripts/import-csv.js --file=<csv> --map=<mapping.json> [--url=...] [--token=...] [--dry-run]'
    );
    process.exit(1);
  }

  const mapping = JSON.parse(await readFile(mapPath, 'utf8'));
  const buf = await readFile(filePath);
  const text = new TextDecoder(mapping.encoding || 'utf-8').decode(buf);

  const rows = parseCsv(text);
  if (rows.length < 2) {
    console.error('CSV にデータ行がありません');
    process.exit(1);
  }
  const [header, ...dataRows] = rows;
  const reservations = dataRows.map((row) => convertRow(row, header, mapping));

  if (dryRun) {
    console.log(JSON.stringify({ count: reservations.length, reservations }, null, 2));
    return;
  }
  if (!token) {
    console.error('--token または INGEST_API_TOKEN が必要です');
    process.exit(1);
  }

  // API 側の上限に合わせて分割送信
  const BATCH = 100;
  const totals = { total: 0, created: 0, updated: 0, failed: 0 };
  for (let i = 0; i < reservations.length; i += BATCH) {
    const batch = reservations.slice(i, i + BATCH);
    const res = await fetch(`${baseUrl}/api/import/reservations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ reservations: batch }),
    });
    if (!res.ok) {
      console.error(`HTTP ${res.status}: ${await res.text()}`);
      process.exit(1);
    }
    const { summary, results } = await res.json();
    for (const key of Object.keys(totals)) totals[key] += summary[key];
    for (const r of results.filter((x) => !x.ok)) {
      console.error(`  失敗: ${r.external_id}: ${r.error}`);
    }
  }
  console.log(
    `取り込み完了: 全${totals.total}件 / 新規${totals.created} / 更新${totals.updated} / 失敗${totals.failed}`
  );
}

// テストから import できるよう、直接実行時のみ main を走らせる
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
