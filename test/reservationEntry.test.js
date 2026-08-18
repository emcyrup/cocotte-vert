import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEntryCommand,
  createReservationEntry,
} from '../src/webhook/events/reservationEntry.js';

const ENTRY = {
  isRequest: true,
  customerName: '田中花子',
  phone: null,
  date: '2026-08-20',
  time: '14:00',
  menu: 'カット',
  staffName: '佐藤',
  durationMinutes: null,
};

const DRAFT = {
  id: 7,
  customer_id: 3,
  customer_name: '田中花子',
  new_customer_name: null,
  staff_id: 1,
  staff_name: '佐藤',
  menu: 'カット',
  reserved_at: '2026-08-20T05:00:00.000Z',
  duration_minutes: null,
  status: 'pending',
};

function makeFakes({
  entry = ENTRY,
  matches = [{ id: 3, name: '田中花子', phone_norm: '09011112222' }],
  staff = { id: 1, name: '佐藤' },
  draft = DRAFT,
  register = { ok: true, draft: DRAFT, createdCustomer: false, reservationId: 42 },
} = {}) {
  const replies = [];
  const created = [];
  const errors = [];
  const calls = [];
  return {
    replies, created, errors, calls,
    lineClient: { reply: async (_t, messages) => replies.push(...messages) },
    slack: { notify: async () => {}, notifyError: async (c, e) => errors.push({ c, m: e.message }) },
    entryParser: { parse: async (args) => { calls.push(args); return entry; } },
    drafts: {
      findCustomers: async () => ({ matches, by: 'name', phoneNorm: null }),
      findStaffByName: async () => staff,
      create: async (args) => { created.push(args); return 7; },
      get: async () => draft,
      pickCustomer: async (args) => { calls.push(args); return { ok: true, draft }; },
      cancel: async (args) => { calls.push(args); return { ok: true }; },
      register: async (args) => { calls.push(args); return register; },
    },
  };
}

const groupEvent = { type: 'message', replyToken: 'r1', source: { type: 'group', groupId: 'G1', userId: 'U1' } };
const userEvent = { type: 'message', replyToken: 'r1', source: { type: 'user', userId: 'U1' } };
const params = (s) => new URLSearchParams(s);
const buttons = (m) => m.contents.footer.contents.map((c) => c.action.data);

test('「予約登録」で始まる発言だけを対象にする', () => {
  assert.equal(parseEntryCommand('予約登録 8/20 14時 田中'), '8/20 14時 田中');
  assert.equal(parseEntryCommand('予約追加：8/20 14時 田中'), '8/20 14時 田中');
  assert.equal(parseEntryCommand('新規予約 8/20 14時 田中'), '8/20 14時 田中');
  assert.equal(parseEntryCommand('　予約入力　8/20'), '8/20');
  // 本文が無くても、書き方を案内できるよう空文字で拾う
  assert.equal(parseEntryCommand('予約登録'), '');
  // 一覧の問い合わせ・普段の会話は拾わない
  for (const text of ['明日の予約', '予約確認', '予約', 'お疲れさまです', '', null]) {
    assert.equal(parseEntryCommand(text), null, String(text));
  }
});

test('該当者が1人なら、その顧客で下書きを作って確認を返す', async () => {
  const f = makeFakes();
  const entry = createReservationEntry({ ...f, now: () => new Date('2026-08-18T01:00:00Z') });

  const handled = await entry.handle(groupEvent, '8/20 14時 田中花子 カット 佐藤');

  assert.equal(handled, true);
  assert.equal(f.calls[0].today, '2026-08-18', 'JST の今日を基準に解釈させる');
  assert.equal(f.created[0].customerId, 3);
  assert.equal(f.created[0].newCustomer, null);
  assert.equal(f.created[0].staffId, 1);
  assert.deepEqual(f.created[0].source, { type: 'group', id: 'G1' });

  const [message] = f.replies;
  assert.equal(message.type, 'flex');
  assert.match(JSON.stringify(message), /田中花子様/);
  assert.match(JSON.stringify(message), /8月20日\(木\) 14:00/);
  assert.deepEqual(buttons(message), ['action=resv&v=ok&d=7', 'action=resv&v=no&d=7']);
});

test('該当者がいなければ、新しいお客様として登録する下書きにする', async () => {
  const f = makeFakes({
    matches: [],
    draft: { ...DRAFT, customer_id: null, customer_name: null, new_customer_name: '田中花子' },
  });
  const entry = createReservationEntry(f);

  await entry.handle(groupEvent, '8/20 14時 田中花子');

  assert.equal(f.created[0].customerId, null);
  assert.equal(f.created[0].newCustomer.name, '田中花子');
  assert.match(JSON.stringify(f.replies[0]), /田中花子様（新規）/);
});

test('同名が複数いたら、どの方かを選ばせる（勝手に決めない）', async () => {
  const f = makeFakes({
    matches: [
      { id: 3, name: '田中花子', phone_norm: '09011112222' },
      { id: 4, name: '田中太郎', phone_norm: null },
    ],
  });
  const entry = createReservationEntry(f);

  await entry.handle(groupEvent, '8/20 14時 田中');

  assert.equal(f.created[0].customerId, null, '候補が絞れないうちは顧客を決めない');
  const [message] = f.replies;
  assert.match(JSON.stringify(message), /どちらのお客様ですか/);
  assert.deepEqual(buttons(message), [
    'action=resv&v=pick&d=7&c=3',
    'action=resv&v=pick&d=7&c=4',
    'action=resv&v=new&d=7',
  ]);
  // 全桁は出さず、見分けがつく最小限だけ添える
  const labels = message.contents.footer.contents.map((c) => c.action.label);
  assert.match(labels[0], /下4桁 2222/);
  assert.doesNotMatch(JSON.stringify(message), /09011112222/);
  assert.match(labels[1], /電話未登録/);
});

test('「予約登録」だけなら、フォームのボタンを返す（読み取りに頼らせない）', async () => {
  const f = makeFakes();
  const entry = createReservationEntry({ ...f, formUrl: 'https://liff.line.me/1-x/staff-reserve.html' });

  await entry.handle(groupEvent, '');

  assert.equal(f.replies.length, 2, '案内文とボタンの2通');
  assert.match(f.replies[0].text, /予約の登録ですね/);
  assert.equal(f.replies[1].type, 'flex');
  assert.match(JSON.stringify(f.replies[1]), /staff-reserve\.html/);
  assert.equal(f.calls.length, 0, '読み取りには回さない');
});

test('読み取れなかったときも、フォームのボタンを添える', async () => {
  const f = makeFakes({ entry: { isRequest: false } });
  const entry = createReservationEntry({ ...f, formUrl: 'https://liff.line.me/1-x/staff-reserve.html' });

  await entry.handle(groupEvent, 'よろしく');

  assert.match(f.replies[0].text, /フォームからも入れられます/);
  assert.equal(f.replies[1].type, 'flex');
});

test('フォームが使えない環境では、これまでどおり書き方を案内する', async () => {
  const f = makeFakes();
  await createReservationEntry(f).handle(groupEvent, '');
  assert.equal(f.replies.length, 1);
  assert.match(f.replies[0].text, /予約登録 8\/20 14時/);
});

test('読み取れない・本文が無いときは書き方を案内する', async () => {
  for (const [entry, body] of [[{ isRequest: false }, 'よろしく'], [ENTRY, '']]) {
    const f = makeFakes({ entry });
    await createReservationEntry(f).handle(groupEvent, body);
    assert.match(f.replies[0].text, /予約登録 8\/20 14時/);
    assert.equal(f.created.length, 0, '読み取れないものを下書きにしない');
  }
});

test('読み取れなかった理由が分かるときは、何を直せばよいかを先に伝える', async () => {
  const cases = [
    ['multiple', /1件ずつ送ってください/],
    ['pet_only', /飼い主様のお名前で送ってください/],
  ];
  for (const [reason, expected] of cases) {
    const f = makeFakes({ entry: { isRequest: false, reason } });
    await createReservationEntry(f).handle(groupEvent, '本文');
    assert.match(f.replies[0].text, expected, reason);
    assert.match(f.replies[0].text, /予約登録 8\/20 14時/, `${reason}: 書き方も添える`);
    assert.equal(f.created.length, 0, reason);
  }
});

test('お泊まりは、泊数と退室日を復唱する', async () => {
  const draft = { ...DRAFT, menu: 'お泊まり', checkout_date: '2026-08-22' };
  const f = makeFakes({ draft });

  await createReservationEntry(f).handle(groupEvent, '8/20 14時 田中花子 お泊まり 2泊');

  const text = JSON.stringify(f.replies[0]);
  assert.match(text, /2泊/);
  assert.match(text, /8月22日\(土\) 退室予定/);
});

test('新しいお客様として入るときは、飼い主様の名前か確かめてもらう', async () => {
  const draft = { ...DRAFT, customer_id: null, customer_name: null, new_customer_name: 'ココ' };
  const f = makeFakes({ matches: [], draft });

  await createReservationEntry(f).handle(groupEvent, '8/20 14時 ココ');

  assert.match(JSON.stringify(f.replies[0]), /新しいお客様として登録されます/);
  assert.match(JSON.stringify(f.replies[0]), /飼い主様のお名前かどうか/);
});

test('既存のお客様なら、新規の注意書きは出さない', async () => {
  const f = makeFakes();
  await createReservationEntry(f).handle(groupEvent, '8/20 14時 田中花子');
  assert.doesNotMatch(JSON.stringify(f.replies[0]), /新しいお客様として登録されます/);
});

test('［登録］で本予約にする', async () => {
  const f = makeFakes();
  const entry = createReservationEntry(f);

  await entry.decide({ ...groupEvent, type: 'postback' }, params('action=resv&v=ok&d=7'));

  assert.deepEqual(f.calls[0], { draftId: 7, source: { type: 'group', id: 'G1' } });
  assert.match(f.replies[0].text, /予約を登録しました/);
  assert.match(f.replies[0].text, /田中花子様/);
  // 直し方が分からず入れ直されると二重になる
  assert.match(f.replies[0].text, /変更・取消は店舗管理画面から/);
});

test('お泊まりは、登録の知らせにも泊数と退室日を出す', async () => {
  const draft = { ...DRAFT, menu: 'お泊まり', checkout_date: '2026-08-22' };
  const f = makeFakes({ draft, register: { ok: true, draft, createdCustomer: false, reservationId: 42 } });

  await createReservationEntry(f).decide(groupEvent, params('action=resv&v=ok&d=7'));

  assert.match(f.replies[0].text, /お泊まり 2泊（8月22日\(土\) 退室予定）/);
});

test('新しいお客様を作ったときは、電話番号の追加を促す', async () => {
  const draft = { ...DRAFT, customer_id: null, customer_name: null, new_customer_name: '山本' };
  const f = makeFakes({ draft, register: { ok: true, draft, createdCustomer: true, reservationId: 9 } });

  await createReservationEntry(f).decide(groupEvent, params('action=resv&v=ok&d=7'));

  assert.match(f.replies[0].text, /山本様/);
  assert.match(f.replies[0].text, /お電話番号/);
});

test('二重に押されても、二度目は登録済みと伝える', async () => {
  const f = makeFakes({ register: { ok: false, error: 'already_decided' } });
  await createReservationEntry(f).decide(groupEvent, params('action=resv&v=ok&d=7'));
  assert.match(f.replies[0].text, /すでに登録済み/);
});

test('古くなった下書きは登録せず、送り直しを促す', async () => {
  const f = makeFakes({ register: { ok: false, error: 'expired' } });
  await createReservationEntry(f).decide(groupEvent, params('action=resv&v=ok&d=7'));
  assert.match(f.replies[0].text, /時間が経ちすぎた/);
});

test('登録に失敗したら、入っていないことを必ず伝えて Slack へも出す', async () => {
  const f = makeFakes();
  f.drafts.register = async () => { throw new Error('DB down'); };

  await createReservationEntry(f).decide(groupEvent, params('action=resv&v=ok&d=7'));

  assert.match(f.replies[0].text, /登録に失敗しました/);
  assert.equal(f.errors.length, 1);
});

test('［やめる］で下書きを取りやめる', async () => {
  const f = makeFakes();
  await createReservationEntry(f).decide(groupEvent, params('action=resv&v=no&d=7'));
  assert.deepEqual(f.calls[0], { draftId: 7, source: { type: 'group', id: 'G1' } });
  assert.match(f.replies[0].text, /やめました/);
});

test('お客様を選ぶと、その内容で確認に進む', async () => {
  const f = makeFakes();
  await createReservationEntry(f).decide(groupEvent, params('action=resv&v=pick&d=7&c=3'));
  assert.deepEqual(f.calls[0], { draftId: 7, source: { type: 'group', id: 'G1' }, customerId: 3 });
  assert.equal(f.replies[0].type, 'flex');
  assert.match(JSON.stringify(f.replies[0]), /この内容で登録しますか/);
});

test('1:1 のトークでも同じように使える', async () => {
  const f = makeFakes();
  await createReservationEntry(f).handle(userEvent, '8/20 14時 田中花子');
  assert.deepEqual(f.created[0].source, { type: 'user', id: 'U1' });
});

test('どこから来たか分からない発言は扱わない', async () => {
  const f = makeFakes();
  const entry = createReservationEntry(f);

  // グループでも、送信者や部屋が特定できない形は下書きを場所で守れない
  const handled = await entry.handle({ replyToken: 'r1', source: { type: 'room', roomId: 'R1' } }, '8/20 14時 田中');

  assert.equal(handled, false);
  assert.equal(f.created.length, 0);
  assert.equal(f.replies.length, 0);
});

test('知らない返事・壊れた下書き番号は無視する', async () => {
  const f = makeFakes();
  const entry = createReservationEntry(f);

  await entry.decide(groupEvent, params('action=resv&v=maybe&d=7'));
  await entry.decide(groupEvent, params('action=resv&v=ok&d=abc'));
  await entry.decide(groupEvent, params('action=resv&v=pick&d=7'));

  assert.equal(f.replies.length, 0);
  assert.equal(f.calls.length, 0);
});
