// 追加リマインド（スタッフが定義する配信ルール）。
// 保存できた設定は必ず送れる設定、にするため入口の検証を厳しくしている。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRule, createCustomReminders } from '../src/customReminders.js';
import { createCustomRemindersJob, fillPlaceholders } from '../src/jobs/customReminders.js';

// ---- 検証 ----

const ok = {
  name: '30日後のご案内', triggerType: 'after_visit', days: 30, sendHour: 10,
  message: '{お名前}\nこんにちは🐾', enabled: true,
};

test('正しい入力はそのまま通る（既定: 10時・ON）', () => {
  assert.deepEqual(validateRule(ok), ok);
  const v = validateRule({ ...ok, sendHour: undefined, enabled: undefined });
  assert.equal(v.sendHour, 10);
  assert.equal(v.enabled, true);
});

test('名前・文面は空にできず、前後の空白は落とす', () => {
  assert.throws(() => validateRule({ ...ok, name: '  ' }), /名前を入れてください/);
  assert.throws(() => validateRule({ ...ok, message: '' }), /文面を入れてください/);
  assert.equal(validateRule({ ...ok, name: ' 案内 ' }).name, '案内');
  assert.throws(() => validateRule({ ...ok, name: 'あ'.repeat(51) }), /50文字まで/);
  assert.throws(() => validateRule({ ...ok, message: 'あ'.repeat(1001) }), /1000文字まで/);
});

test('日数はタイミングの種類ごとの範囲で見る', () => {
  assert.equal(validateRule({ ...ok, days: 365 }).days, 365);
  assert.throws(() => validateRule({ ...ok, days: 366 }), /1〜365/);
  assert.throws(() => validateRule({ ...ok, days: 0 }), /1〜365/);
  // 予約の◯日前は 30 日まで（それより前に送っても予約が確定していない）
  const before = { ...ok, triggerType: 'before_reservation', days: 30 };
  assert.equal(validateRule(before).days, 30);
  assert.throws(() => validateRule({ ...before, days: 31 }), /1〜30/);
  assert.throws(() => validateRule({ ...ok, triggerType: 'weekly' }), /種類を選んでください/);
});

test('配信時刻は 9〜20 時のみ（深夜・早朝に送らない守り）', () => {
  assert.equal(validateRule({ ...ok, sendHour: 9 }).sendHour, 9);
  assert.equal(validateRule({ ...ok, sendHour: 20 }).sendHour, 20);
  for (const bad of [8, 21, 9.5]) {
    assert.throws(() => validateRule({ ...ok, sendHour: bad }), /9〜20 時/);
  }
});

// ---- 文面の差し込み ----

test('{お名前} だけを置き換える。他の中括弧は触らない', () => {
  assert.equal(
    fillPlaceholders('{お名前}、{お名前}へ。{未知}はそのまま', { customerName: '山田 花子' }),
    '山田 花子 様、山田 花子 様へ。{未知}はそのまま'
  );
});

// ---- ジョブ ----

function makeFakes({ rules = [], targets = [] } = {}) {
  const queries = [];
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/FROM custom_reminders/.test(sql)) return { rows: rules };
      if (/FROM reservations/.test(sql)) return { rows: targets };
      return { rows: [] };
    },
  };
  const delivered = [];
  const lineClient = {
    deliver: async (args) => { delivered.push(args); return { status: 'sent' }; },
  };
  return { pool, lineClient, delivered, queries };
}

const RULE = { id: 3, name: '案内', trigger_type: 'after_visit', days: 30, message: '{お名前}、お元気ですか' };
const TARGET = { id: 55, customer_id: 7, line_user_id: 'U1', customer_name: '山田 花子' };

test('その時刻のルールだけを動かし、ルールごとに dedupe_key を分ける', async () => {
  const f = makeFakes({ rules: [RULE], targets: [TARGET] });
  const job = createCustomRemindersJob({ ...f, hourOf: () => 14 });

  const summary = await job();
  assert.equal(summary.total, 1);
  assert.equal(summary.sent, 1);

  // ルールの絞り込みに時刻が渡っている
  assert.deepEqual(f.queries[0].params, [14]);
  const d = f.delivered[0];
  assert.equal(d.jobType, 'custom');
  assert.equal(d.dedupeKey, 'custom:3:res:55', 'ルールid×予約idで一意');
  assert.equal(d.messages[0].text, '山田 花子 様、お元気ですか');
});

test('ルールが無い時刻は何も送らない', async () => {
  const f = makeFakes({ rules: [] });
  const summary = await createCustomRemindersJob({ ...f, hourOf: () => 10 })();
  assert.equal(summary.total, 0);
  assert.equal(f.delivered.length, 0);
});

test('対象者1人の失敗で他を止めず、顧客は内部 id で記録する', async () => {
  const f = makeFakes({
    rules: [RULE],
    targets: [TARGET, { id: 56, customer_id: 8, line_user_id: 'U2', customer_name: 'B' }],
  });
  let first = true;
  f.lineClient.deliver = async (args) => {
    if (first) { first = false; throw new Error('落ちた'); }
    f.delivered.push(args);
    return { status: 'sent' };
  };
  const summary = await createCustomRemindersJob({ ...f, hourOf: () => 14 })();
  assert.equal(summary.failed, 1);
  assert.equal(summary.sent, 1);
  assert.deepEqual(summary.errors, [{ customerId: 7, message: '落ちた' }]);
});

test('対象者の抽出で opt_out・ブロック・LINE未連携を除外している', async () => {
  // どちらの条件の SQL にも守りの3条件が入っていることを、実際に発行される文で見る。
  // ここが消えると「送ってはいけない方に送る」なので、文字列検査でも止める価値がある
  for (const triggerType of ['after_visit', 'before_reservation']) {
    const sqls = [];
    const pool = {
      query: async (sql) => {
        sqls.push(sql);
        if (/FROM custom_reminders/.test(sql)) {
          return { rows: [{ ...RULE, trigger_type: triggerType }] };
        }
        return { rows: [] };
      },
    };
    await createCustomRemindersJob({ pool, lineClient: {}, hourOf: () => 10 })();
    const target = sqls.find((s) => /FROM reservations/.test(s));
    assert.match(target, /opt_out = false/, triggerType);
    assert.match(target, /is_blocked = false/, triggerType);
    assert.match(target, /line_user_id IS NOT NULL/, triggerType);
  }
});

// ---- サービス（保存まわり）----

test('create は検証してから INSERT し、update は部分更新でも全体を検証し直す', async () => {
  const queries = [];
  const row = {
    id: 1, name: '案内', trigger_type: 'after_visit', days: 30, send_hour: 10,
    message: 'm', enabled: true, created_at: 'now',
  };
  const pool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/INSERT INTO custom_reminders/.test(sql)) return { rows: [row] };
      if (/^\s*SELECT/.test(sql)) return { rows: [row] };
      if (/UPDATE custom_reminders/.test(sql)) return { rows: [{ ...row, days: params[3] }] };
      return { rows: [], rowCount: 1 };
    },
  };
  const svc = createCustomReminders({ pool });

  await assert.rejects(() => svc.create({ name: '', triggerType: 'after_visit', days: 1, message: 'm' }), /名前/);

  const created = await svc.create({ name: '案内', triggerType: 'after_visit', days: 30, message: 'm' });
  assert.equal(created.triggerType, 'after_visit');

  // 部分更新: days だけ変えても他の値と合わせて検証される
  const updated = await svc.update(1, { days: 60 });
  assert.equal(updated.days, 60);
  await assert.rejects(() => svc.update(1, { days: 0 }), /1〜365/);
});
