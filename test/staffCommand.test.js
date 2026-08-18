import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStaffCommandHandler } from '../src/webhook/events/staffCommand.js';

const STAFF_GROUP = 'Cstaff-group';

function makeDeps({ stored = {}, staffLineGroupId = null, linkResult = null, codeResult = null } = {}) {
  const replies = [];
  const linkCalls = [];
  const codeCalls = [];
  const settings = {
    get: async (key) => stored[key] ?? null,
    set: async () => {},
  };
  const lineClient = {
    reply: async (_token, messages) => replies.push(messages[0].text),
  };
  const shiftService = linkResult || codeResult
    ? {
        linkStaffByName: async (args) => {
          linkCalls.push(args);
          return linkResult;
        },
        linkStaffByCode: async (args) => {
          codeCalls.push(args);
          return codeResult;
        },
      }
    : null;
  return {
    replies,
    linkCalls,
    codeCalls,
    handler: createStaffCommandHandler({
      settings,
      lineClient,
      config: { staffLineGroupId },
      shiftService,
    }),
  };
}

function groupEvent(text, groupId = STAFF_GROUP) {
  return { source: { type: 'group', groupId, userId: 'U-staff' }, replyToken: 'rt', message: { text } };
}

test('スタッフグループで「配信結果」と送ると保存済みの結果を応答で返す', async () => {
  const { handler, replies } = makeDeps({
    stored: {
      staff_line_group_id: STAFF_GROUP,
      last_job_summary: ':package: *ジョブ実行結果*（8月7日(金) 10:00 実行）\n・前々日確認: 対象 2 / 送信 2',
    },
  });

  const handled = await handler(groupEvent('配信結果'), '配信結果');

  assert.equal(handled, true);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /ジョブ実行結果/);
  assert.match(replies[0], /前々日確認: 対象 2/);
  assert.doesNotMatch(replies[0], /:package:|\*/, 'LINE 向けにプレーンテキスト化される');
});

test('まだ実行結果がなければその旨を返す', async () => {
  const { handler, replies } = makeDeps({ stored: { staff_line_group_id: STAFF_GROUP } });

  const handled = await handler(groupEvent('配信結果'), '配信結果');

  assert.equal(handled, true);
  assert.match(replies[0], /まだ実行結果がありません/);
});

test('表記ゆれ（空白・記号・別名）も受け付ける', async () => {
  const { handler, replies } = makeDeps({
    stored: { staff_line_group_id: STAFF_GROUP, last_job_summary: '結果です' },
  });

  for (const text of ['配信結果', ' 配信 結果 ', '配信結果？', 'ジョブ結果', '実行結果']) {
    assert.equal(await handler(groupEvent(text), text), true, text);
  }
  assert.equal(replies.length, 5);
});

test('通知先に設定されていない別のグループには応答しない', async () => {
  const { handler, replies } = makeDeps({
    stored: { staff_line_group_id: STAFF_GROUP, last_job_summary: '結果です' },
  });

  const handled = await handler(groupEvent('配信結果', 'C-other-group'), '配信結果');

  assert.equal(handled, false, '店内の数字を第三者のグループに出さない');
  assert.equal(replies.length, 0);
});

test('顧客との1対1のトークでは反応しない', async () => {
  const { handler, replies } = makeDeps({
    stored: { staff_line_group_id: STAFF_GROUP, last_job_summary: '結果です' },
  });

  const event = { source: { type: 'user', userId: 'U-customer' }, replyToken: 'rt' };
  assert.equal(await handler(event, '配信結果'), false);
  assert.equal(replies.length, 0);
});

test('コマンド以外の発言は素通しする（通常の処理へ委ねる）', async () => {
  const { handler, replies } = makeDeps({ stored: { staff_line_group_id: STAFF_GROUP } });

  assert.equal(await handler(groupEvent('今日の予約どうなってる？'), '今日の予約どうなってる？'), false);
  assert.equal(replies.length, 0);
});

test('グループIDが未設定なら応答しない（誤爆防止）', async () => {
  const { handler, replies } = makeDeps({ stored: { last_job_summary: '結果です' } });

  assert.equal(await handler(groupEvent('配信結果'), '配信結果'), false);
  assert.equal(replies.length, 0);
});

test('DB 未設定でも環境変数のグループIDで判定できる', async () => {
  const { handler, replies } = makeDeps({
    stored: { last_job_summary: '結果です' },
    staffLineGroupId: STAFF_GROUP,
  });

  assert.equal(await handler(groupEvent('配信結果'), '配信結果'), true);
  assert.equal(replies.length, 1);
});

// ---- グループでのスタッフ LINE 連携 ----

test('スタッフグループで名前を送ると LINE アカウントを連携する', async () => {
  const { handler, replies, linkCalls } = makeDeps({
    stored: { staff_line_group_id: STAFF_GROUP },
    linkResult: { ok: true, staff: { id: 3, name: '高橋' } },
  });

  const handled = await handler(groupEvent('スタッフ登録 高橋'), 'スタッフ登録 高橋');

  assert.equal(handled, true);
  assert.deepEqual(linkCalls[0], { lineUserId: 'U-staff', name: '高橋' });
  assert.match(replies[0], /高橋さんのLINEアカウントを連携しました/);
});

test('同名のスタッフが複数いるときは連携せず、画面での設定を促す', async () => {
  const { handler, replies } = makeDeps({
    stored: { staff_line_group_id: STAFF_GROUP },
    linkResult: { ok: false, error: 'ambiguous' },
  });

  await handler(groupEvent('スタッフ登録 佐藤'), 'スタッフ登録 佐藤');

  assert.match(replies[0], /複数います/);
});

test('登録の無い名前は連携しない', async () => {
  const { handler, replies } = makeDeps({
    stored: { staff_line_group_id: STAFF_GROUP },
    linkResult: { ok: false, error: 'not_found' },
  });

  await handler(groupEvent('スタッフ登録 存在しない人'), 'スタッフ登録 存在しない人');

  assert.match(replies[0], /見つかりません/);
});

test('対象外のグループでは連携せず、送り方を案内する（無言で終わらせない）', async () => {
  const { handler, replies, linkCalls } = makeDeps({
    stored: { staff_line_group_id: STAFF_GROUP },
    linkResult: { ok: true, staff: { id: 3, name: '高橋' } },
  });

  const handled = await handler(groupEvent('スタッフ登録 高橋', 'C-other'), 'スタッフ登録 高橋');

  assert.equal(handled, true);
  assert.equal(linkCalls.length, 0, '対象外のグループでは連携しない');
  assert.match(replies[0], /設定されていない/);
});

test('スタッフ通知先が未設定でも、送り方を案内して無言にしない', async () => {
  const { handler, replies, linkCalls } = makeDeps({
    linkResult: { ok: true, staff: { id: 3, name: '高橋' } },
  });

  const handled = await handler(groupEvent('スタッフ登録 高橋'), 'スタッフ登録 高橋');

  assert.equal(handled, true);
  assert.equal(linkCalls.length, 0);
  assert.match(replies[0], /まだ設定されていません/);
  assert.match(replies[0], /1対1のトーク/, '代わりの手段を示す');
});

test('送信者を特定できないグループ発言は、1:1 での登録を案内する', async () => {
  const { handler, replies, linkCalls } = makeDeps({
    stored: { staff_line_group_id: STAFF_GROUP },
    codeResult: { ok: true, staff: { id: 3, name: '高橋' } },
  });
  const event = { source: { type: 'group', groupId: STAFF_GROUP }, replyToken: 'rt', message: { text: 'スタッフ登録 123456' } };

  const handled = await handler(event, 'スタッフ登録 123456');

  assert.equal(handled, true);
  assert.equal(linkCalls.length, 0);
  assert.match(replies[0], /特定できませんでした/);
});

test('全角数字の連携コードでも受け付ける（スマホ入力で起きやすい）', async () => {
  const { handler, codeCalls } = makeDeps({
    stored: { staff_line_group_id: STAFF_GROUP },
    codeResult: { ok: true, staff: { id: 3, name: '高橋' } },
  });

  await handler(groupEvent('スタッフ登録　１２３４５６'), 'スタッフ登録　１２３４５６');

  assert.deepEqual(codeCalls[0], { lineUserId: 'U-staff', code: '123456' });
});

test('区切りが無くてもコードとして受け付ける', async () => {
  const { handler, codeCalls } = makeDeps({
    stored: { staff_line_group_id: STAFF_GROUP },
    codeResult: { ok: true, staff: { id: 3, name: '高橋' } },
  });

  await handler(groupEvent('スタッフ登録123456'), 'スタッフ登録123456');

  assert.equal(codeCalls[0].code, '123456');
});

test('問い合わせ系のコマンドは対象外グループでは従来どおり黙る', async () => {
  const { handler, replies } = makeDeps({ stored: { staff_line_group_id: STAFF_GROUP } });

  const handled = await handler(groupEvent('配信結果', 'C-other'), '配信結果');

  assert.equal(handled, false);
  assert.equal(replies.length, 0);
});

test('名前の無い連携コマンドはコマンドとして扱わない', async () => {
  const { handler, linkCalls } = makeDeps({
    stored: { staff_line_group_id: STAFF_GROUP },
    linkResult: { ok: true, staff: { id: 3, name: '高橋' } },
  });

  assert.equal(await handler(groupEvent('スタッフ登録'), 'スタッフ登録'), false);
  assert.equal(linkCalls.length, 0);
});

test('スタッフグループで6桁の連携コードを送ると、名前ではなくコードとして扱う', async () => {
  const { handler, replies, codeCalls, linkCalls } = makeDeps({
    stored: { staff_line_group_id: STAFF_GROUP },
    codeResult: { ok: true, staff: { id: 3, name: '高橋' } },
  });

  const handled = await handler(groupEvent('スタッフ登録 123456'), 'スタッフ登録 123456');

  assert.equal(handled, true);
  assert.deepEqual(codeCalls[0], { lineUserId: 'U-staff', code: '123456' });
  assert.equal(linkCalls.length, 0, '数字を名前として探しにいかない');
  assert.match(replies[0], /高橋さんのLINEアカウントを連携しました/);
});

test('期限切れの連携コードはコードとして案内する（名前が見つからない扱いにしない）', async () => {
  const { handler, replies } = makeDeps({
    stored: { staff_line_group_id: STAFF_GROUP },
    codeResult: { ok: false, error: 'invalid_code' },
  });

  await handler(groupEvent('スタッフ登録 123456'), 'スタッフ登録 123456');

  assert.match(replies[0], /連携コードを確認できませんでした/);
});

// ---- 予約の問い合わせ（グループ限定）----
// お客様の氏名を含む一覧を返すため、「設定済みのスタッフグループ以外では返さない」ことが
// この機能でいちばん大事な性質。壊れると顧客情報が第三者に見える

function makeResvDeps({ staffLineGroupId = STAFF_GROUP } = {}) {
  const replies = [];
  const asked = [];
  return {
    replies,
    asked,
    handler: createStaffCommandHandler({
      settings: { get: async () => null, set: async () => {} },
      lineClient: { reply: async (_t, m) => replies.push(m[0].text) },
      config: { staffLineGroupId },
      reservationQuery: {
        summarize: async (date) => {
          asked.push(date);
          return `${date} の一覧です`;
        },
      },
    }),
  };
}

test('スタッフグループの「今日の予約」には一覧を返す', async () => {
  const { handler, replies, asked } = makeResvDeps();
  assert.equal(await handler(groupEvent('今日の予約'), '今日の予約'), true);
  assert.equal(asked.length, 1);
  assert.match(replies[0], /の一覧です/);
});

test('別のグループには予約を返さない（顧客名を第三者に見せない）', async () => {
  const { handler, replies, asked } = makeResvDeps();
  assert.equal(await handler(groupEvent('今日の予約', 'C-other'), '今日の予約'), false);
  assert.deepEqual(asked, []);
  assert.deepEqual(replies, []);
});

test('スタッフグループが未設定なら予約を返さない', async () => {
  const { handler, replies, asked } = makeResvDeps({ staffLineGroupId: null });
  assert.equal(await handler(groupEvent('今日の予約'), '今日の予約'), false);
  assert.deepEqual(asked, []);
  assert.deepEqual(replies, []);
});

test('1対1トーク（顧客）からは予約を返さない', async () => {
  const { handler, replies, asked } = makeResvDeps();
  const dm = { source: { type: 'user', userId: 'U-customer' }, replyToken: 'rt' };
  assert.equal(await handler(dm, '今日の予約'), false);
  assert.deepEqual(asked, []);
  assert.deepEqual(replies, []);
});

test('予約と関係ない発言はグループでも横取りしない', async () => {
  const { handler, asked } = makeResvDeps();
  assert.equal(await handler(groupEvent('おつかれさまです'), 'おつかれさまです'), false);
  assert.deepEqual(asked, []);
});

test('取得に失敗しても落ちず、その旨を返す', async () => {
  const replies = [];
  const handler = createStaffCommandHandler({
    settings: { get: async () => null, set: async () => {} },
    lineClient: { reply: async (_t, m) => replies.push(m[0].text) },
    config: { staffLineGroupId: STAFF_GROUP },
    reservationQuery: { summarize: async () => { throw new Error('db down'); } },
  });
  assert.equal(await handler(groupEvent('今日の予約'), '今日の予約'), true);
  assert.match(replies[0], /取得できませんでした/);
});

// ---- 予約の登録（スタッフ用グループから）----

function makeEntryDeps({ staffLineGroupId = STAFF_GROUP } = {}) {
  const replies = [];
  const handled = [];
  return {
    replies,
    handled,
    handler: createStaffCommandHandler({
      settings: { get: async () => null, set: async () => {} },
      lineClient: { reply: async (_t, m) => replies.push(m[0].text) },
      config: { staffLineGroupId },
      reservationQuery: { summarize: async () => '一覧' },
      reservationEntry: {
        handle: async (_event, body) => { handled.push(body); return true; },
        decide: async () => {},
      },
    }),
  };
}

test('スタッフグループの「予約登録 …」は登録の処理へ渡す', async () => {
  const { handler, handled } = makeEntryDeps();
  const text = '予約登録 8/20 14時 田中花子 カット';
  assert.equal(await handler(groupEvent(text), text), true);
  assert.deepEqual(handled, ['8/20 14時 田中花子 カット']);
});

test('「予約登録」は一覧の問い合わせより先に判定する', async () => {
  const replies = [];
  const asked = [];
  const handled = [];
  const handler = createStaffCommandHandler({
    settings: { get: async () => null, set: async () => {} },
    lineClient: { reply: async (_t, m) => replies.push(m[0].text) },
    config: { staffLineGroupId: STAFF_GROUP },
    reservationQuery: { summarize: async (d) => { asked.push(d); return '一覧'; } },
    reservationEntry: {
      handle: async (_e, body) => { handled.push(body); return true; },
      decide: async () => {},
    },
  });

  await handler(groupEvent('予約登録 明日14時 田中'), '予約登録 明日14時 田中');

  assert.deepEqual(handled, ['明日14時 田中']);
  assert.deepEqual(asked, [], '一覧の問い合わせには回さない');
});

test('別のグループからは予約を登録できない', async () => {
  const { handler, handled, replies } = makeEntryDeps();
  const text = '予約登録 8/20 14時 田中花子';
  assert.equal(await handler(groupEvent(text, 'C-other'), text), false);
  assert.deepEqual(handled, []);
  assert.deepEqual(replies, []);
});

test('スタッフグループが未設定なら予約を登録できない', async () => {
  const { handler, handled } = makeEntryDeps({ staffLineGroupId: null });
  const text = '予約登録 8/20 14時 田中花子';
  assert.equal(await handler(groupEvent(text), text), false);
  assert.deepEqual(handled, []);
});
