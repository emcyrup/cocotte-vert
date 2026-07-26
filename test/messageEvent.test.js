import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMessageHandler } from '../src/webhook/events/message.js';

function makeFakes({ outcome = 'linked', customerId = 7 } = {}) {
  const replies = [];
  const linkCalls = [];
  const lineClient = {
    getProfile: async () => ({ displayName: '花子' }),
    reply: async (token, messages) => replies.push({ token, messages }),
  };
  const linkService = {
    linkByPhoneText: async (args) => {
      linkCalls.push(args);
      return { outcome, customerId };
    },
  };
  return { lineClient, linkService, replies, linkCalls };
}

test('電話番号らしきテキストは突合を試行し、成功なら完了を返信する', async () => {
  const { lineClient, linkService, replies, linkCalls } = makeFakes({ outcome: 'linked' });
  const handler = createMessageHandler({ lineClient, linkService });

  await handler({
    type: 'message',
    replyToken: 'r1',
    source: { userId: 'U1' },
    message: { type: 'text', text: '090-1234-5678' },
  });

  assert.equal(linkCalls.length, 1);
  assert.equal(linkCalls[0].displayName, '花子');
  assert.equal(replies.length, 1);
  assert.match(replies[0].messages[0].text, /お繋ぎしました/);
});

test('突合失敗時は担当者からの連絡を案内する', async () => {
  const { lineClient, linkService, replies } = makeFakes({ outcome: 'not_found' });
  const handler = createMessageHandler({ lineClient, linkService });

  await handler({
    type: 'message',
    replyToken: 'r1',
    source: { userId: 'U1' },
    message: { type: 'text', text: '090-9999-9999' },
  });
  assert.match(replies[0].messages[0].text, /担当者よりご連絡/);
});

test('電話番号でないテキストは何もしない（Phase 4 で分類する）', async () => {
  const { lineClient, linkService, replies, linkCalls } = makeFakes();
  const handler = createMessageHandler({ lineClient, linkService });

  await handler({
    type: 'message',
    replyToken: 'r1',
    source: { userId: 'U1' },
    message: { type: 'text', text: '予約を変更したいです' },
  });
  assert.equal(linkCalls.length, 0);
  assert.equal(replies.length, 0);
});

test('テキスト以外のメッセージは無視する', async () => {
  const { lineClient, linkService, linkCalls } = makeFakes();
  const handler = createMessageHandler({ lineClient, linkService });

  await handler({
    type: 'message',
    replyToken: 'r1',
    source: { userId: 'U1' },
    message: { type: 'sticker' },
  });
  assert.equal(linkCalls.length, 0);
});
