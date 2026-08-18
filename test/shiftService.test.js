import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createShiftService, formatShift } from '../src/shifts/service.js';

function makePool(handlers = []) {
  const queries = [];
  return {
    queries,
    query: async (sql, params) => {
      queries.push({ sql, params });
      for (const [re, result] of handlers) {
        if (re.test(sql)) return typeof result === 'function' ? result(params) : result;
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function makeFakes(handlers) {
  const pushes = [];
  const errors = [];
  return {
    pool: makePool(handlers),
    pushes,
    errors,
    lineClient: {
      pushStaff: async (to, text) => {
        pushes.push({ to, text });
        return { status: 'sent' };
      },
    },
    slack: { notifyError: async (title, err) => errors.push({ title, message: err.message }) },
  };
}

test('日付ラベルは JST の曜日で組み立てる', () => {
  assert.equal(formatShift({ target_date: '2026-08-01', kind: 'yukyu' }), '8/1(土) 有休');
  assert.equal(
    formatShift({ target_date: '2026-07-31', kind: 'jikan', start_time: '10:00', end_time: '12:00' }),
    '7/31(金) 時間休 10:00〜12:00'
  );
  assert.equal(formatShift({ target_date: '2026-12-25', kind: 'am' }), '12/25(金) AM半休');
});

test('申請を保存し、同じ日の未決着は置き換える', async () => {
  const f = makeFakes([
    [/DELETE FROM shift_requests/, { rows: [], rowCount: 1 }],
    [/INSERT INTO shift_requests/, (p) => ({ rows: [{ id: 7, target_date: p[1], kind: p[2] }] })],
  ]);
  const service = createShiftService(f);

  const result = await service.createRequests({
    staffId: 3,
    entries: [{ date: '2026-08-01', kind: 'yukyu', startTime: null, endTime: null, reason: '家庭の用事' }],
    rawText: '8/1 有休お願いします',
  });

  assert.equal(result.created.length, 1);
  assert.equal(result.replaced, 1, '同じ日の未決着を消してから入れる');
  const del = f.pool.queries.find((q) => /DELETE FROM shift_requests/.test(q.sql));
  assert.match(del.sql, /status IN \('pending', 'held'\)/, '確定・却下済みの履歴は消さない');
  const insert = f.pool.queries.find((q) => /INSERT INTO shift_requests/.test(q.sql));
  assert.equal(insert.params[6], '8/1 有休お願いします', '原文を必ず残す');
});

test('承認するとスタッフ本人へ LINE で通知する', async () => {
  const f = makeFakes([
    [/UPDATE shift_requests/, { rows: [{ id: 7 }] }],
    [/SELECT[\s\S]*FROM shift_requests r JOIN staff/, {
      rows: [{ id: 7, staff_id: 3, staff_name: '高橋', target_date: '2026-08-01', kind: 'yukyu',
               start_time: null, end_time: null, status: 'approved', line_user_id: 'U-staff' }],
    }],
  ]);
  const service = createShiftService(f);

  const result = await service.decide({ id: 7, status: 'approved' });

  assert.equal(result.ok, true);
  assert.equal(result.notified, true);
  assert.equal(result.delivery, 'sent');
  assert.equal(f.pushes[0].to, 'U-staff');
  assert.match(f.pushes[0].text, /承認されました/);
  assert.match(f.pushes[0].text, /8\/1\(土\) 有休/);
  assert.equal(result.request.line_user_id, undefined, 'LINE userId は画面へ返さない');
});

test('却下でも本人へ理由が分かる形で通知する', async () => {
  const f = makeFakes([
    [/UPDATE shift_requests/, { rows: [{ id: 8 }] }],
    [/SELECT[\s\S]*FROM shift_requests r JOIN staff/, {
      rows: [{ id: 8, staff_id: 3, staff_name: '山本', target_date: '2026-07-31', kind: 'jikan',
               start_time: '10:00', end_time: '12:00', status: 'rejected', line_user_id: 'U-staff' }],
    }],
  ]);
  const service = createShiftService(f);
  await service.decide({ id: 8, status: 'rejected' });

  assert.match(f.pushes[0].text, /見送り/);
  assert.match(f.pushes[0].text, /7\/31\(金\) 時間休 10:00〜12:00/);
});

test('通知に失敗しても承認は確定させ、Slack で知らせる', async () => {
  const f = makeFakes([
    [/UPDATE shift_requests/, { rows: [{ id: 7 }] }],
    [/SELECT[\s\S]*FROM shift_requests r JOIN staff/, {
      rows: [{ id: 7, staff_id: 3, staff_name: '高橋', target_date: '2026-08-01', kind: 'yukyu',
               start_time: null, end_time: null, status: 'approved', line_user_id: 'U-staff' }],
    }],
  ]);
  f.lineClient.pushStaff = async () => { throw new Error('LINE API down'); };
  const service = createShiftService(f);

  const result = await service.decide({ id: 7, status: 'approved' });

  assert.equal(result.ok, true, '通知失敗で承認まで巻き戻さない');
  assert.equal(result.notified, false);
  assert.equal(result.delivery, 'failed');
  assert.equal(f.errors.length, 1);
});

test('承認待ち以外は二重に処理しない', async () => {
  const f = makeFakes([[/UPDATE shift_requests/, { rows: [] }]]);
  const service = createShiftService(f);
  const result = await service.decide({ id: 7, status: 'approved' });
  assert.deepEqual(result, { ok: false, error: 'not_found' });
  assert.equal(f.pushes.length, 0);
});

test('不正な状態は受け付けない', async () => {
  const service = createShiftService(makeFakes());
  assert.deepEqual(await service.decide({ id: 1, status: 'pending' }), { ok: false, error: 'invalid_status' });
});

test('連携コードは期限切れ・使用済みだと弾かれる', async () => {
  const f = makeFakes([[/UPDATE staff/, { rows: [] }]]);
  const service = createShiftService(f);
  const result = await service.linkStaffByCode({ lineUserId: 'U1', code: '123456' });
  assert.deepEqual(result, { ok: false, error: 'invalid_code' });
  const q = f.pool.queries[0];
  assert.match(q.sql, /link_code_expires_at > now\(\)/, '期限を SQL 側で判定する');
});

test('連携コードは6桁で発行し、有効期限を持たせる', async () => {
  const f = makeFakes([[/UPDATE staff/, { rows: [{ id: 3, name: '高橋' }] }]]);
  const service = createShiftService(f);

  const result = await service.issueLinkCode(3);

  assert.equal(result.ok, true);
  assert.match(result.code, /^\d{6}$/);
  assert.equal(f.pool.queries[0].params[1], result.code);
  assert.match(f.pool.queries[0].sql, /link_code_expires_at = now\(\) \+ make_interval/);
});

test('連携済みの LINE アカウントを別スタッフに付け替えない', async () => {
  const f = makeFakes([[/UPDATE staff/, { rows: [{ id: 3, name: '高橋' }] }]]);
  const service = createShiftService(f);
  await service.linkStaffByCode({ lineUserId: 'U1', code: '123456' });
  assert.match(f.pool.queries[0].sql, /NOT EXISTS \(SELECT 1 FROM staff o WHERE o\.line_user_id/);
});

// ---- グループでの名前による連携 / グループ参加の確認 ----

test('名前でスタッフを特定して連携する', async () => {
  const f = makeFakes([
    [/SELECT id, name FROM staff/, { rows: [{ id: 3, name: '高橋' }] }],
    [/UPDATE staff SET line_user_id/, { rows: [{ id: 3, name: '高橋' }] }],
  ]);
  const service = createShiftService(f);

  const result = await service.linkStaffByName({ lineUserId: 'U1', name: '高橋' });

  assert.deepEqual(result, { ok: true, staff: { id: 3, name: '高橋' } });
  // 姓名の間の空白の入れ方が揺れても一致させる
  assert.match(f.pool.queries[0].sql, /replace\(replace\(name, ' ', ''\), '　', ''\)/);
});

test('同名のスタッフが複数いるときは誤爆を避けて連携しない', async () => {
  const f = makeFakes([
    [/SELECT id, name FROM staff/, { rows: [{ id: 3, name: '佐藤' }, { id: 9, name: '佐藤' }] }],
  ]);
  const service = createShiftService(f);
  assert.deepEqual(await service.linkStaffByName({ lineUserId: 'U1', name: '佐藤' }), {
    ok: false, error: 'ambiguous',
  });
  assert.equal(f.pool.queries.length, 1, '更新まで進まない');
});

test('該当者がいなければ連携しない', async () => {
  const f = makeFakes([[/SELECT id, name FROM staff/, { rows: [] }]]);
  const service = createShiftService(f);
  assert.deepEqual(await service.linkStaffByName({ lineUserId: 'U1', name: '誰か' }), {
    ok: false, error: 'not_found',
  });
});

test('他のスタッフに紐付いた LINE アカウントは奪わない', async () => {
  const f = makeFakes([
    [/SELECT id, name FROM staff/, { rows: [{ id: 3, name: '高橋' }] }],
    [/UPDATE staff SET line_user_id/, { rows: [] }],
  ]);
  const service = createShiftService(f);
  assert.deepEqual(await service.linkStaffByName({ lineUserId: 'U1', name: '高橋' }), {
    ok: false, error: 'already_linked_to_other',
  });
});

test('グループ未設定なら参加状況は判定しない', async () => {
  const f = makeFakes();
  const service = createShiftService({ ...f, settings: { get: async () => null }, config: {} });
  assert.deepEqual(await service.listStaffLineStatus(), { groupConfigured: false, membership: {} });
});

test('連携済みスタッフのグループ参加状況を返す', async () => {
  const f = makeFakes([
    [/SELECT id, line_user_id FROM staff/, { rows: [{ id: 3, line_user_id: 'U3' }, { id: 4, line_user_id: 'U4' }] }],
  ]);
  f.lineClient.getGroupMembership = async (_g, u) => (u === 'U3' ? 'joined' : 'left');
  const service = createShiftService({ ...f, settings: { get: async () => 'Cgroup' } });

  const result = await service.listStaffLineStatus();

  assert.equal(result.groupConfigured, true);
  assert.deepEqual(result.membership, { 3: 'joined', 4: 'left' });
});

// ---- 週次シフト ----

test('シフトを登録・更新する（同じ日は上書き）', async () => {
  const f = makeFakes([
    [/INSERT INTO shifts/, { rows: [{ id: 1, work_date: '2026-08-03', kind: 'work' }] }],
  ]);
  const service = createShiftService(f);

  const result = await service.upsertShift({ staffId: 3, date: '2026-08-03', kind: 'work' });

  assert.equal(result.ok, true);
  const q = f.pool.queries[0];
  assert.match(q.sql, /ON CONFLICT \(staff_id, work_date\) DO UPDATE/, '同じマスは上書きする');
  assert.deepEqual(q.params, [3, '2026-08-03', 'work', null, null]);
});

test('時間休以外に時刻を残さない', async () => {
  const f = makeFakes([[/INSERT INTO shifts/, { rows: [{ id: 1 }] }]]);
  const service = createShiftService(f);

  await service.upsertShift({ staffId: 3, date: '2026-08-03', kind: 'koukyu', startTime: '10:00', endTime: '12:00' });

  assert.deepEqual(f.pool.queries[0].params.slice(3), [null, null]);
});

test('時間休は時刻を保持する', async () => {
  const f = makeFakes([[/INSERT INTO shifts/, { rows: [{ id: 1 }] }]]);
  const service = createShiftService(f);

  await service.upsertShift({ staffId: 3, date: '2026-08-03', kind: 'jikan', startTime: '10:00', endTime: '12:00' });

  assert.deepEqual(f.pool.queries[0].params.slice(3), ['10:00', '12:00']);
});

test('kind が無ければ未入力に戻す（行を消す）', async () => {
  const f = makeFakes();
  const service = createShiftService(f);

  const result = await service.upsertShift({ staffId: 3, date: '2026-08-03', kind: null });

  assert.deepEqual(result, { ok: true, shift: null });
  assert.match(f.pool.queries[0].sql, /DELETE FROM shifts/);
});

test('シフト未入力のスタッフも一覧に出す（追加した人の行が増えるように）', async () => {
  const f = makeFakes([
    [/SELECT id, name FROM staff/, { rows: [{ id: 3, name: '高橋' }, { id: 4, name: '新人' }] }],
    [/FROM shifts/, { rows: [{ staff_id: 3, work_date: '2026-08-03', kind: 'work' }] }],
  ]);
  const service = createShiftService(f);

  const result = await service.listShifts({ from: '2026-08-03', to: '2026-08-09' });

  assert.equal(result.staff.length, 2, 'シフトが1件も無いスタッフも返す');
  assert.equal(result.shifts.length, 1);
});

test('申請を承認するとシフト表にも反映する', async () => {
  const f = makeFakes([
    [/UPDATE shift_requests/, { rows: [{ id: 7 }] }],
    [/SELECT[\s\S]*FROM shift_requests r JOIN staff/, {
      rows: [{ id: 7, staff_id: 3, staff_name: '高橋', target_date: '2026-08-01', kind: 'yukyu',
               start_time: null, end_time: null, status: 'approved', line_user_id: 'U-staff' }],
    }],
    [/INSERT INTO shifts/, { rows: [{ id: 1 }] }],
  ]);
  const service = createShiftService(f);

  await service.decide({ id: 7, status: 'approved' });

  const upsert = f.pool.queries.find((q) => /INSERT INTO shifts/.test(q.sql));
  assert.ok(upsert, '承認したらシフト表へ書き込む');
  assert.deepEqual(upsert.params.slice(0, 3), [3, '2026-08-01', 'yukyu']);
  assert.match(f.pushes[0].text, /シフト表に反映しました/);
});

test('却下ではシフト表を変更しない', async () => {
  const f = makeFakes([
    [/UPDATE shift_requests/, { rows: [{ id: 8 }] }],
    [/SELECT[\s\S]*FROM shift_requests r JOIN staff/, {
      rows: [{ id: 8, staff_id: 3, staff_name: '高橋', target_date: '2026-08-01', kind: 'yukyu',
               start_time: null, end_time: null, status: 'rejected', line_user_id: 'U-staff' }],
    }],
  ]);
  const service = createShiftService(f);

  await service.decide({ id: 8, status: 'rejected' });

  assert.equal(f.pool.queries.filter((q) => /INSERT INTO shifts/.test(q.sql)).length, 0);
});

test('本人の「確定」で、その人の返事待ちだけをシフト表へ入れる', async () => {
  const f = makeFakes([
    [/SELECT[\s\S]*WHERE r\.staff_id = \$1 AND r\.status = 'pending'/, {
      rows: [{ id: 7, staff_id: 3, staff_name: '高橋', target_date: '2026-08-01', kind: 'yukyu',
               start_time: null, end_time: null, status: 'pending' }],
    }],
    [/UPDATE shift_requests/, { rows: [{ id: 7 }] }],
    [/INSERT INTO shifts/, { rows: [{ id: 1 }] }],
  ]);
  const service = createShiftService(f);

  const result = await service.answerOwnRequests({ staffId: 3, answer: 'confirm' });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'approved');
  const update = f.pool.queries.find((q) => /UPDATE shift_requests/.test(q.sql));
  // 他人の申請を動かせないよう、id だけでなく staff_id も条件に入れる
  assert.match(update.sql, /staff_id = \$2/);
  assert.deepEqual(update.params, [[7], 3, 'approved']);
  const upsert = f.pool.queries.find((q) => /INSERT INTO shifts/.test(q.sql));
  assert.deepEqual(upsert.params.slice(0, 3), [3, '2026-08-01', 'yukyu']);
});

test('本人の「保留」は held にするだけで、シフト表は変えない', async () => {
  const f = makeFakes([
    [/SELECT[\s\S]*WHERE r\.staff_id = \$1 AND r\.status = 'pending'/, {
      rows: [{ id: 7, staff_id: 3, staff_name: '高橋', target_date: '2026-08-01', kind: 'yukyu',
               start_time: null, end_time: null, status: 'pending' }],
    }],
    [/UPDATE shift_requests/, { rows: [{ id: 7 }] }],
  ]);
  const service = createShiftService(f);

  const result = await service.answerOwnRequests({ staffId: 3, answer: 'hold' });

  assert.equal(result.status, 'held');
  assert.equal(f.pool.queries.filter((q) => /INSERT INTO shifts/.test(q.sql)).length, 0);
});

test('返事待ちが無ければ no_pending を返す', async () => {
  const f = makeFakes([]);
  const service = createShiftService(f);

  const result = await service.answerOwnRequests({ staffId: 3, answer: 'confirm' });

  assert.deepEqual(result, { ok: false, error: 'no_pending' });
  assert.equal(f.pool.queries.filter((q) => /UPDATE shift_requests/.test(q.sql)).length, 0);
});

test('別経路で先に決まっていたら、取れなかった分は反映しない', async () => {
  const f = makeFakes([
    [/SELECT[\s\S]*WHERE r\.staff_id = \$1 AND r\.status = 'pending'/, {
      rows: [{ id: 7, staff_id: 3, target_date: '2026-08-01', kind: 'yukyu', start_time: null, end_time: null }],
    }],
    // 店長が管理画面で先に決めた等で、UPDATE が1件も取れなかった場合
    [/UPDATE shift_requests/, { rows: [] }],
  ]);
  const service = createShiftService(f);

  const result = await service.answerOwnRequests({ staffId: 3, answer: 'confirm' });

  assert.deepEqual(result, { ok: false, error: 'no_pending' });
  assert.equal(f.pool.queries.filter((q) => /INSERT INTO shifts/.test(q.sql)).length, 0);
});

test('店長は本人が保留にしたものも承認できる', async () => {
  const f = makeFakes([
    [/UPDATE shift_requests/, { rows: [{ id: 9 }] }],
    [/SELECT[\s\S]*FROM shift_requests r JOIN staff/, {
      rows: [{ id: 9, staff_id: 3, staff_name: '高橋', target_date: '2026-08-01', kind: 'yukyu',
               start_time: null, end_time: null, status: 'approved', line_user_id: 'U-staff' }],
    }],
    [/INSERT INTO shifts/, { rows: [{ id: 1 }] }],
  ]);
  const service = createShiftService(f);

  const result = await service.decide({ id: 9, status: 'approved' });

  assert.equal(result.ok, true);
  const update = f.pool.queries.find((q) => /UPDATE shift_requests/.test(q.sql));
  assert.match(update.sql, /status IN \('pending', 'held'\)/, '決着済みは動かさない');
});

// ---- LIFF のスタッフ登録画面から紐付ける ----

test('名前での検索は在職者だけ。空白の入れ方が違っても当てる', async () => {
  const f = makeFakes([
    [/SELECT id, name, \(line_user_id IS NOT NULL\)/, { rows: [{ id: 1, name: '佐藤', linked: false }] }],
  ]);
  const service = createShiftService(f);

  await service.listActiveStaffByName('佐藤');

  assert.match(f.pool.queries[0].sql, /active = true/, '退職者は出さない');
  assert.match(f.pool.queries[0].sql, /replace\(replace\(name, ' ', ''\), '　', ''\)/);
  assert.doesNotMatch(f.pool.queries[0].sql, /line_user_id AS/, 'LINE userId そのものは返さない');
});

test('入力された名前が名簿に1人だけなら、その人に紐付ける', async () => {
  const f = makeFakes([
    [/SELECT id, name, \(line_user_id IS NOT NULL\)/, { rows: [{ id: 3, name: '高橋', linked: false }] }],
    [/UPDATE staff SET line_user_id/, { rows: [{ id: 3, name: '高橋' }] }],
  ]);
  const service = createShiftService(f);

  const result = await service.linkStaffByTypedName({ lineUserId: 'U1', name: ' 高橋 ' });

  assert.deepEqual(result, { ok: true, staff: { id: 3, name: '高橋' } });
  assert.equal(f.pool.queries.filter((q) => /INSERT INTO staff/.test(q.sql)).length, 0, '既にいるなら作らない');
});

test('名簿に無い名前は、新しいスタッフとして作って紐付ける', async () => {
  const f = makeFakes([
    [/SELECT id, name, \(line_user_id IS NOT NULL\)/, { rows: [] }],
    [/SELECT id, name FROM staff WHERE line_user_id/, { rows: [] }],
    [/INSERT INTO staff/, { rows: [{ id: 9, name: '新人' }] }],
  ]);
  const service = createShiftService(f);

  const result = await service.linkStaffByTypedName({ lineUserId: 'U1', name: '新人' });

  assert.deepEqual(result, { ok: true, staff: { id: 9, name: '新人' }, created: true });
  const insert = f.pool.queries.find((q) => /INSERT INTO staff/.test(q.sql));
  assert.deepEqual(insert.params, ['新人', 'U1']);
});

test('同じ名前が複数いるときは決めず、候補を返す', async () => {
  const candidates = [{ id: 1, name: '佐藤', linked: true }, { id: 5, name: '佐藤', linked: false }];
  const f = makeFakes([[/SELECT id, name, \(line_user_id IS NOT NULL\)/, { rows: candidates }]]);
  const service = createShiftService(f);

  const result = await service.linkStaffByTypedName({ lineUserId: 'U1', name: '佐藤' });

  assert.deepEqual(result, { ok: false, error: 'ambiguous', candidates });
  assert.equal(f.pool.queries.length, 1, '決められないうちは何も書き換えない');
});

test('既に別のスタッフとして登録済みの LINE では、新しく作らない', async () => {
  const f = makeFakes([
    [/SELECT id, name, \(line_user_id IS NOT NULL\)/, { rows: [] }],
    [/SELECT id, name FROM staff WHERE line_user_id/, { rows: [{ id: 2, name: '既存' }] }],
  ]);
  const service = createShiftService(f);

  const result = await service.linkStaffByTypedName({ lineUserId: 'U1', name: '別名' });

  assert.equal(result.error, 'already_linked_to_other');
  assert.equal(f.pool.queries.filter((q) => /INSERT INTO staff/.test(q.sql)).length, 0,
    '使われないスタッフを名簿に残さない');
});

test('空の名前・長すぎる名前は受け付けない', async () => {
  const f = makeFakes([]);
  const service = createShiftService(f);

  for (const name of ['', '   ', '　', null, undefined, 'あ'.repeat(31)]) {
    assert.deepEqual(await service.linkStaffByTypedName({ lineUserId: 'U1', name }),
      { ok: false, error: 'invalid_name' }, String(name));
  }
  assert.equal(f.pool.queries.length, 0, '問い合わせにも行かない');
});

test('名前ではなく id で紐付けるので、同姓でも取り違えない', async () => {
  const f = makeFakes([[/UPDATE staff SET line_user_id/, { rows: [{ id: 3, name: '佐藤' }] }]]);
  const service = createShiftService(f);

  const result = await service.linkStaffById({ lineUserId: 'U1', staffId: 3 });

  assert.deepEqual(result, { ok: true, staff: { id: 3, name: '佐藤' } });
  assert.deepEqual(f.pool.queries[0].params, ['U1', 3]);
  assert.match(f.pool.queries[0].sql, /active = true/, '退職者には紐付けない');
  assert.match(
    f.pool.queries[0].sql,
    /NOT EXISTS \(SELECT 1 FROM staff o WHERE o\.line_user_id/,
    '連携済みの LINE アカウントを別のスタッフへ付け替えない'
  );
  assert.match(f.pool.queries[0].sql, /link_code = NULL/, '発行済みのコードは使い捨てに戻す');
});

test('紐付けられなかった理由を分けて返す', async () => {
  // 相手が居ない（退職・削除）
  const gone = makeFakes([
    [/UPDATE staff SET line_user_id/, { rows: [] }],
    [/SELECT 1 FROM staff WHERE id/, { rows: [] }],
  ]);
  assert.deepEqual(await createShiftService(gone).linkStaffById({ lineUserId: 'U1', staffId: 9 }), {
    ok: false, error: 'not_found',
  });

  // 相手は居るが、この LINE アカウントが既に別のスタッフのもの
  const taken = makeFakes([
    [/UPDATE staff SET line_user_id/, { rows: [] }],
    [/SELECT 1 FROM staff WHERE id/, { rows: [{ '?column?': 1 }] }],
  ]);
  assert.deepEqual(await createShiftService(taken).linkStaffById({ lineUserId: 'U1', staffId: 2 }), {
    ok: false, error: 'already_linked_to_other',
  });
});

test('退職として残っている名前では、勝手に作り直さない', async () => {
  // 同じ名前が名簿に2つ並ぶのを避ける。復帰かどうかは店長が決める
  const f = makeFakes([
    [/SELECT id, name, \(line_user_id IS NOT NULL\)/, { rows: [] }],
    [/SELECT 1 FROM staff\s+WHERE active = false/, { rows: [{ '?column?': 1 }] }],
  ]);
  const service = createShiftService(f);

  const result = await service.linkStaffByTypedName({ lineUserId: 'U1', name: '元スタッフ' });

  assert.deepEqual(result, { ok: false, error: 'retired_name' });
  assert.equal(f.pool.queries.filter((q) => /INSERT INTO staff/.test(q.sql)).length, 0);
});
