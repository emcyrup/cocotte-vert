import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {
  PLATFORMS,
  PLATFORM_KEYS,
  isPlatform,
  labelOf,
  maxCaptionOf,
  photoRequiredFor,
  splitForPlatform,
} from '../src/sns/platforms.js';
import { createSnsRouter } from '../src/http/snsRoutes.js';

const files = (n) => Array.from({ length: n }, (_, i) => `f${i}.jpg`);

test('投稿先の表に必要な項目が揃っている', () => {
  for (const key of PLATFORM_KEYS) {
    const p = PLATFORMS[key];
    assert.equal(typeof p.label, 'string', key);
    assert.ok(p.maxPhotos > 0, key);
    assert.ok(p.maxCaption > 0, key);
    assert.equal(typeof p.split, 'boolean', key);
    assert.equal(typeof p.photoRequired, 'boolean', key);
  }
  // 追加予定のものも含め、画面に出す4つが揃っている
  assert.deepEqual(PLATFORM_KEYS, ['instagram', 'threads', 'x', 'wordpress']);
});

test('未知の投稿先は弾く', () => {
  assert.equal(isPlatform('instagram'), true);
  assert.equal(isPlatform('mixi'), false);
  // プロトタイプ汚染で通ってしまわないこと
  assert.equal(isPlatform('toString'), false);
  assert.equal(isPlatform('__proto__'), false);
});

test('ラベルと文字数上限は表から引く', () => {
  assert.equal(labelOf('threads'), 'スレッズ');
  assert.equal(labelOf('mixi'), 'mixi', '未知でも落ちない');
  assert.equal(maxCaptionOf('x'), 280);
  assert.equal(maxCaptionOf('instagram'), 2200);
});

test('Instagram は10枚で分割し、2投稿目に「つづき」が付く', () => {
  const parts = splitForPlatform('instagram', files(12), '本文');
  assert.equal(parts.length, 2);
  assert.equal(parts[0].files.length, 10);
  assert.equal(parts[1].files.length, 2);
  assert.equal(parts[0].caption, '本文');
  assert.match(parts[1].caption, /つづき（2\/2）/);
});

test('10枚ちょうどは分割しない', () => {
  const parts = splitForPlatform('instagram', files(10), '本文');
  assert.equal(parts.length, 1);
  assert.equal(parts[0].caption, '本文');
});

test('分割しない投稿先は上限までで打ち切る（連投にしない）', () => {
  // スレッズは20枚まで1投稿
  const th = splitForPlatform('threads', files(25), '本文');
  assert.equal(th.length, 1);
  assert.equal(th[0].files.length, 20);
  // X は4枚まで
  const x = splitForPlatform('x', files(10), '本文');
  assert.equal(x.length, 1);
  assert.equal(x[0].files.length, 4);
});

test('未知の投稿先は Instagram の決まりで扱う（落とさない）', () => {
  const parts = splitForPlatform('mixi', files(12), '本文');
  assert.equal(parts.length, 2);
});

// ---- 投稿先一覧の API ----

async function withServer(app, fn) {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

function makeApp(clients) {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/sns', createSnsRouter({
    pool: { query: async () => ({ rows: [] }) },
    publisher: {},
    dataDir: '/tmp',
    clients,
  }));
  return app;
}

test('設定済みの投稿先は available、未設定は false で返る', async () => {
  const app = makeApp({
    instagram: { postMode: 'live' },
    threads: { postMode: 'dry_run' },
  });
  await withServer(app, async (base) => {
    const { platforms } = await (await fetch(`${base}/api/admin/sns/platforms`)).json();
    const by = Object.fromEntries(platforms.map((p) => [p.key, p]));

    assert.equal(by.instagram.available, true);
    assert.equal(by.instagram.mode, 'live');
    assert.equal(by.threads.available, true);
    assert.equal(by.threads.mode, 'dry_run', 'dry_run のままかを画面に出せる');

    // まだ用意していない投稿先も、消さずに「未設定」として返す
    assert.equal(by.x.available, false);
    assert.equal(by.x.mode, null);
    assert.equal(by.wordpress.available, false);
  });
});

test('文字数・枚数の上限も画面へ渡す', async () => {
  await withServer(makeApp({}), async (base) => {
    const { platforms } = await (await fetch(`${base}/api/admin/sns/platforms`)).json();
    const by = Object.fromEntries(platforms.map((p) => [p.key, p]));
    assert.equal(by.threads.maxCaption, 500);
    assert.equal(by.x.maxCaption, 280);
    assert.equal(by.x.maxPhotos, 4);
    assert.equal(by.instagram.photoRequired, true);
    assert.equal(by.wordpress.photoRequired, false);
  });
});

test('photoRequiredFor は表のとおり返し、知らない投稿先は「要る」に倒す', () => {
  assert.equal(photoRequiredFor('instagram'), true);
  assert.equal(photoRequiredFor('threads'), true);
  assert.equal(photoRequiredFor('wordpress'), false);
  assert.equal(photoRequiredFor('x'), false);
  // 知らない投稿先で写真なしを黙って通さない
  assert.equal(photoRequiredFor('mixi'), true);
  assert.equal(photoRequiredFor(undefined), true);
});

test('DB の CHECK 制約が、表にある投稿先を全部許している', async () => {
  // 表（platforms.js）に投稿先を足しても、sns_posts の CHECK 制約を更新し忘れると
  // 挿入が DB で弾かれ、画面には「internal error」しか出ない。WordPress で実際に起きた。
  // 制約を持つ最新のマイグレーションを読み、表の全キーが入っていることを見る
  const { readdir, readFile } = await import('node:fs/promises');
  const dir = new URL('../src/db/migrations/', import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

  let latest = null;
  for (const f of files) {
    const sql = await readFile(new URL(f, dir), 'utf8');
    if (/ADD CONSTRAINT sns_posts_platform_check/.test(sql)) latest = sql;
  }
  assert.ok(latest, '制約を張るマイグレーションが見つからない');

  const m = latest.match(/CHECK \(platform IN \(([^)]+)\)\)/);
  assert.ok(m, '制約の形が変わっている。テストを追随させること');
  const allowed = m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
  for (const key of PLATFORM_KEYS) {
    assert.ok(allowed.includes(key), `DB の制約に ${key} が無い。マイグレーションを足すこと`);
  }
});
