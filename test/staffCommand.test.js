import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStaffCommandHandler } from '../src/webhook/events/staffCommand.js';

const STAFF_GROUP = 'Cstaff-group';

function makeDeps({ stored = {}, staffLineGroupId = null } = {}) {
  const replies = [];
  const settings = {
    get: async (key) => stored[key] ?? null,
    set: async () => {},
  };
  const lineClient = {
    reply: async (_token, messages) => replies.push(messages[0].text),
  };
  return {
    replies,
    handler: createStaffCommandHandler({
      settings,
      lineClient,
      config: { staffLineGroupId },
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
