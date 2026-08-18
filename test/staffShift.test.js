import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStaffShiftHandler, createShiftAnswerHandler, parseShiftAnswer } from '../src/webhook/events/staffShift.js';

const YUKYU_0801 = { id: 7, target_date: '2026-08-01', kind: 'yukyu', start_time: null, end_time: null };

function makeFakes({
  staff = null,
  parsed = { isRequest: false, entries: [] },
  link = { ok: false, error: 'invalid_code' },
  answer = { ok: false, error: 'no_pending' },
} = {}) {
  const replies = [];
  const notices = [];
  const created = [];
  const answers = [];
  return {
    replies,
    notices,
    created,
    answers,
    // Flex も受け取るため、本文だけでなくメッセージ全体を残す
    lineClient: {
      reply: async (token, messages) =>
        replies.push({ token, text: messages[0].text, message: messages[0] }),
    },
    slack: { notify: async (text) => notices.push(text) },
    shiftParser: { parse: async () => parsed },
    shiftService: {
      findStaffByLineUserId: async () => staff,
      linkStaffByCode: async (args) => { created.push(args); return link; },
      createRequests: async (args) => {
        created.push(args);
        return { created: args.entries.map((e) => ({ target_date: e.date, kind: e.kind, start_time: e.startTime, end_time: e.endTime })), replaced: 0 };
      },
      answerOwnRequests: async (args) => { answers.push(args); return answer; },
    },
  };
}

/** Flex の中から postback ボタンの label を集める */
const buttonLabels = (message) =>
  (message.contents?.footer?.contents ?? []).map((c) => c.action?.label);

const userEvent = (text) => ({
  type: 'message',
  replyToken: 'r1',
  source: { type: 'user', userId: 'U-staff' },
  message: { type: 'text', text },
});

test('連携済みスタッフの申請には、確定・保留・やめる を聞き返す', async () => {
  const f = makeFakes({
    staff: { id: 3, name: '高橋' },
    parsed: { isRequest: true, entries: [{ date: '2026-08-01', kind: 'yukyu', startTime: null, endTime: null, reason: null }] },
  });
  const handler = createStaffShiftHandler({ ...f, now: () => new Date('2026-07-24T01:00:00Z') });

  const handled = await handler(userEvent('8/1 有休お願いします'), '8/1 有休お願いします');

  assert.equal(handled, true, '顧客向けの処理へは渡さない');
  const [{ message }] = f.replies;
  assert.equal(message.type, 'flex');
  assert.match(JSON.stringify(message), /8\/1\(土\) 有休/);
  assert.deepEqual(buttonLabels(message), ['確定', '保留', 'やめる']);
  // AI の読み違いをそのまま入れないため、この時点ではシフト表に触れない
  assert.equal(f.answers.length, 0);
  assert.equal(f.notices.length, 0, '本人が答える前に店長を呼ばない');
});

test('「確定」でシフト表へ反映し、店長へも知らせる', async () => {
  const f = makeFakes({
    staff: { id: 3, name: '高橋' },
    answer: { ok: true, status: 'approved', requests: [YUKYU_0801] },
  });
  const handler = createStaffShiftHandler(f);

  const handled = await handler(userEvent('確定'), '確定');

  assert.equal(handled, true);
  assert.deepEqual(f.answers[0], { staffId: 3, answer: 'confirm' });
  assert.match(f.replies[0].text, /シフト表に反映しました/);
  assert.match(f.replies[0].text, /8\/1\(土\) 有休/);
  assert.equal(f.notices.length, 1);
  assert.match(f.notices[0], /確定しました/);
});

test('「保留」は店長の判断待ちとして通知する', async () => {
  const f = makeFakes({
    staff: { id: 3, name: '高橋' },
    answer: { ok: true, status: 'held', requests: [YUKYU_0801] },
  });
  const handler = createStaffShiftHandler(f);

  await handler(userEvent('保留'), '保留');

  assert.deepEqual(f.answers[0], { staffId: 3, answer: 'hold' });
  assert.match(f.replies[0].text, /保留にしました/);
  assert.match(f.notices[0], /保留になりました/);
  assert.match(f.notices[0], /管理画面/);
});

test('確認待ちがないのに返事だけ来たら、送り方を案内する', async () => {
  const f = makeFakes({ staff: { id: 3, name: '高橋' }, answer: { ok: false, error: 'no_pending' } });
  const handler = createStaffShiftHandler(f);

  const handled = await handler(userEvent('確定'), '確定');

  assert.equal(handled, true);
  assert.match(f.replies[0].text, /確認待ちのシフト変更はありません/);
  assert.equal(f.notices.length, 0, '何も決まっていないのに店長へ流さない');
});

test('返事は申請より先に読む（「やめる」を新しい申請にしない）', async () => {
  const f = makeFakes({
    staff: { id: 3, name: '高橋' },
    parsed: { isRequest: true, entries: [{ date: '2026-08-01', kind: 'yukyu', startTime: null, endTime: null, reason: null }] },
    answer: { ok: true, status: 'rejected', requests: [YUKYU_0801] },
  });
  const handler = createStaffShiftHandler(f);

  await handler(userEvent('やめる'), 'やめる');

  assert.equal(f.created.length, 0, '申請として保存しない');
  assert.match(f.replies[0].text, /取りやめました/);
});

test('返事の表記ゆれを吸収する', async () => {
  const cases = {
    確定: 'confirm', 'OK': 'confirm', はい: 'confirm', 'お願いします。': 'confirm',
    保留: 'hold', ほりゅう: 'hold', 考えます: 'hold',
    やめる: 'cancel', キャンセル: 'cancel', 取り消し: 'cancel',
  };
  for (const [text, expected] of Object.entries(cases)) {
    assert.equal(parseShiftAnswer(text), expected, text);
  }
  // シフトの希望そのものを返事と取り違えない
  for (const text of ['8/1 有休お願いします', 'お疲れさまです', '']) {
    assert.equal(parseShiftAnswer(text), null, text);
  }
});

test('ボタン（postback）でも文字と同じ処理に入る', async () => {
  const f = makeFakes({
    staff: { id: 3, name: '高橋' },
    answer: { ok: true, status: 'approved', requests: [YUKYU_0801] },
  });
  const handleShiftAnswer = createShiftAnswerHandler(f);

  const handled = await handleShiftAnswer(
    { type: 'postback', replyToken: 'r1', source: { type: 'user', userId: 'U-staff' }, postback: { data: 'action=shift&v=confirm' } },
    'confirm'
  );

  assert.equal(handled, true);
  assert.deepEqual(f.answers[0], { staffId: 3, answer: 'confirm' });
  assert.match(f.replies[0].text, /シフト表に反映しました/);
});

test('未連携の相手がボタンを押しても何も起きない', async () => {
  const f = makeFakes({ staff: null });
  const handleShiftAnswer = createShiftAnswerHandler(f);

  const handled = await handleShiftAnswer(
    { type: 'postback', replyToken: 'r1', source: { type: 'user', userId: 'U-guest' }, postback: { data: 'action=shift&v=confirm' } },
    'confirm'
  );

  assert.equal(handled, false);
  assert.equal(f.replies.length, 0);
  assert.equal(f.answers.length, 0);
});

test('未連携（＝顧客）の発言は従来の処理へ渡す', async () => {
  const f = makeFakes({ staff: null });
  const handler = createStaffShiftHandler(f);

  const handled = await handler(userEvent('ありがとうございました'), 'ありがとうございました');

  assert.equal(handled, false);
  assert.equal(f.replies.length, 0);
});

test('グループでの発言は申請にしない（雑談を拾わないため）', async () => {
  const f = makeFakes({ staff: { id: 3, name: '高橋' } });
  const handler = createStaffShiftHandler(f);

  const handled = await handler(
    { type: 'message', replyToken: 'r1', source: { type: 'group', groupId: 'G1', userId: 'U-staff' }, message: { type: 'text', text: '8/1 有休' } },
    '8/1 有休'
  );

  assert.equal(handled, false);
});

test('読み取れない発言には書き方を案内して終わる', async () => {
  const f = makeFakes({ staff: { id: 3, name: '高橋' }, parsed: { isRequest: false, entries: [] } });
  const handler = createStaffShiftHandler(f);

  const handled = await handler(userEvent('お疲れさまです'), 'お疲れさまです');

  assert.equal(handled, true);
  assert.match(f.replies[0].text, /読み取れませんでした/);
  assert.equal(f.notices.length, 0, '申請でないものを店長へ通知しない');
});

test('連携コマンドは未連携でも受け付ける', async () => {
  const f = makeFakes({ staff: null, link: { ok: true, staff: { id: 3, name: '高橋' } } });
  const handler = createStaffShiftHandler(f);

  const handled = await handler(userEvent('スタッフ登録 123456'), 'スタッフ登録 123456');

  assert.equal(handled, true);
  assert.equal(f.created[0].code, '123456');
  assert.match(f.replies[0].text, /高橋さん、連携しました/);
});

test('連携コードが無効なら再発行を案内する', async () => {
  const f = makeFakes({ staff: null, link: { ok: false, error: 'invalid_code' } });
  const handler = createStaffShiftHandler(f);

  await handler(userEvent('スタッフ登録 999999'), 'スタッフ登録 999999');

  assert.match(f.replies[0].text, /確認できませんでした/);
});

test('連携コマンドは表記ゆれを吸収する', async () => {
  for (const text of ['スタッフ登録123456', 'スタッフ連携 123456', 'スタッフ登録：123456']) {
    const f = makeFakes({ staff: null, link: { ok: true, staff: { id: 3, name: '高橋' } } });
    const handler = createStaffShiftHandler(f);
    assert.equal(await handler(userEvent(text), text), true, text);
  }
});

test('6桁の数字だけの発言は連携コマンドにしない（顧客の誤爆を防ぐ）', async () => {
  const f = makeFakes({ staff: null });
  const handler = createStaffShiftHandler(f);
  assert.equal(await handler(userEvent('123456'), '123456'), false);
});

test('1:1 で名前を送られたら、コードでの登録方法を案内する', async () => {
  const f = makeFakes({ staff: null, link: { ok: true, staff: { id: 3, name: '高橋' } } });
  const handler = createStaffShiftHandler(f);

  const handled = await handler(userEvent('スタッフ登録 高橋'), 'スタッフ登録 高橋');

  assert.equal(handled, true, '黙って顧客向けの処理へ落とさない');
  assert.match(f.replies[0].text, /6桁の連携コード/);
  // 名前だけで成りすませないよう、1:1 では名前による連携を行わない
  assert.equal(f.created.length, 0);
});

test('接頭辞なしでコードだけ送っても、発行済みなら連携する', async () => {
  const f = makeFakes({ staff: null, link: { ok: true, staff: { id: 3, name: '高橋' } } });
  const handler = createStaffShiftHandler(f);

  const handled = await handler(userEvent('123456'), '123456');

  assert.equal(handled, true);
  assert.equal(f.created[0].code, '123456');
  assert.match(f.replies[0].text, /高橋さん、連携しました/);
});

test('発行済みでない6桁は連携せず、顧客の会話を横取りしない', async () => {
  const f = makeFakes({ staff: null, link: { ok: false, error: 'invalid_code' } });
  const handler = createStaffShiftHandler(f);

  const handled = await handler(userEvent('123456'), '123456');

  assert.equal(handled, false, '従来どおり顧客向けの処理へ渡す');
  assert.equal(f.replies.length, 0);
});

test('連携済みスタッフが6桁を送っても、シフト申請の処理へ進む', async () => {
  const f = makeFakes({
    staff: { id: 3, name: '高橋' },
    link: { ok: false, error: 'invalid_code' },
    parsed: { isRequest: false, entries: [] },
  });
  const handler = createStaffShiftHandler(f);

  const handled = await handler(userEvent('123456'), '123456');

  assert.equal(handled, true);
  assert.match(f.replies[0].text, /読み取れませんでした/, 'コード不一致で処理が逸れない');
});
