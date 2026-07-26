import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStaffNotifier, toPlainText } from '../src/notify/staffNotifier.js';
import { createJoinHandler } from '../src/webhook/events/join.js';

function makeFakes({ channel = 'slack', groupId = 'Cgroup1' } = {}) {
  const slackSent = [];
  const lineSent = [];
  const slack = {
    notify: async (text) => {
      slackSent.push(text);
      return true;
    },
  };
  const lineClient = {
    pushStaff: async (to, text) => {
      lineSent.push({ to, text });
      return { status: 'sent' };
    },
  };
  const config = { staffNotifyChannel: channel, staffLineGroupId: groupId };
  return { slack, lineClient, config, slackSent, lineSent };
}

test('デフォルト（slack）は Slack のみに送る', async () => {
  const f = makeFakes({ channel: 'slack' });
  const notifier = createStaffNotifier(f);
  await notifier.notify('テスト通知');
  assert.equal(f.slackSent.length, 1);
  assert.equal(f.lineSent.length, 0);
});

test('line チャネルは LINE グループのみに送る', async () => {
  const f = makeFakes({ channel: 'line' });
  const notifier = createStaffNotifier(f);
  await notifier.notify(':calendar: *新規予約*\n顧客: 山田');
  assert.equal(f.slackSent.length, 0);
  assert.equal(f.lineSent.length, 1);
  assert.equal(f.lineSent[0].to, 'Cgroup1');
  assert.equal(f.lineSent[0].text, '📅 新規予約\n顧客: 山田', 'Slack 記法が変換される');
});

test('both は両方に送る', async () => {
  const f = makeFakes({ channel: 'both' });
  const notifier = createStaffNotifier(f);
  await notifier.notify('通知');
  assert.equal(f.slackSent.length, 1);
  assert.equal(f.lineSent.length, 1);
});

test('LINE 送信の失敗は例外を外に漏らさない', async () => {
  const f = makeFakes({ channel: 'line' });
  f.lineClient.pushStaff = async () => {
    throw new Error('LINE API down');
  };
  const notifier = createStaffNotifier(f);
  const ok = await notifier.notify('通知');
  assert.equal(ok, false);
});

test('toPlainText: 絵文字コード・強調・引用・コードブロックを変換する', () => {
  assert.equal(toPlainText(':warning: *要対応*'), '⚠️ 要対応');
  assert.equal(toPlainText('> 引用行'), '引用行');
  assert.equal(toPlainText('```stack trace```'), 'stack trace');
  assert.equal(toPlainText(':unknown_emoji: text'), ' text');
});

test('join イベント: グループ ID を返信する', async () => {
  const replies = [];
  const lineClient = { reply: async (token, messages) => replies.push(messages[0].text) };
  const handler = createJoinHandler({ lineClient });

  await handler({ type: 'join', replyToken: 'r1', source: { type: 'group', groupId: 'Cabc123' } });
  assert.equal(replies.length, 1);
  assert.match(replies[0], /Cabc123/);
  assert.match(replies[0], /STAFF_LINE_GROUP_ID/);
});

test('join イベント: グループ以外（複数人トーク等）は無視する', async () => {
  const replies = [];
  const lineClient = { reply: async (token, messages) => replies.push(messages) };
  const handler = createJoinHandler({ lineClient });

  await handler({ type: 'join', replyToken: 'r1', source: { type: 'room', roomId: 'R1' } });
  assert.equal(replies.length, 0);
});
