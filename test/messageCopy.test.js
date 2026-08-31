// 顧客へ送る文面の見張り番。
//
// このシステムは美容室向けの文面から作り始めたため、「髪や頭皮のことで」のような
// 前の業種の言い回しが残っていたことがある。人が読み返さないと気付けない類の間違いなので、
// 語彙をテストで固定しておく。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPreReminderMessage } from '../src/line/messages/preReminder.js';
import { buildAfterVisitMessage } from '../src/line/messages/afterVisit.js';
import { buildDormantMessage } from '../src/line/messages/dormant.js';
import { buildBirthdayMessage } from '../src/line/messages/birthday.js';
import {
  buildRequestReceivedMessage,
  buildConfirmedMessage,
  buildDeclinedMessage,
} from '../src/line/messages/reservationStatus.js';

// 前の業種（美容室）の語。顧客向けの文面に出てはいけない
const SALON_WORDS = [
  '頭皮', '髪', 'ヘア', '美容室', '美容院', 'カラーリング', 'パーマ',
  'スタイリスト', '施術', 'ヘアスタイル', 'トリートメント',
];

const args = {
  customerName: '山田',
  reservedAt: new Date('2026-08-20T01:00:00Z'),
  menu: 'シャンプー＆カットコース',
  staffName: '佐藤',
  reservationId: 1,
  couponUrl: 'https://example.com/coupon',
};

const MESSAGES = [
  ['前々日確認', buildPreReminderMessage(args)],
  ['来店7日後フォロー', buildAfterVisitMessage(args)],
  ['休眠フォロー', buildDormantMessage(args)],
  ['誕生日', buildBirthdayMessage(args)],
  ['予約リクエスト受付', buildRequestReceivedMessage(args)],
  ['予約の確定', buildConfirmedMessage(args)],
  ['予約の見送り', buildDeclinedMessage(args)],
];

/** Flex / text を問わず、顧客の目に触れる文字列を全部集める */
function visibleText(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (typeof node.text === 'string') out.push(node.text);
  if (typeof node.altText === 'string') out.push(node.altText);
  if (typeof node.label === 'string') out.push(node.label);
  if (typeof node.displayText === 'string') out.push(node.displayText);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((v) => visibleText(v, out));
    else if (value && typeof value === 'object') visibleText(value, out);
  }
  return out;
}

for (const [name, message] of MESSAGES) {
  test(`${name}: 前の業種の言い回しが混ざっていない`, () => {
    const text = visibleText(message).join('\n');
    for (const word of SALON_WORDS) {
      assert.ok(!text.includes(word), `「${word}」が残っています:\n${text}`);
    }
  });
}

test('わんちゃんの話だと分かる文面になっている', () => {
  // 飼い主様ご本人の体調を尋ねているように読める文面を防ぐ。
  // 予約の受付・見送りは事務連絡なので対象外
  for (const name of ['前々日確認', '来店7日後フォロー', '休眠フォロー', '予約の確定']) {
    const [, message] = MESSAGES.find(([n]) => n === name);
    const text = visibleText(message).join('\n');
    assert.match(text, /わんちゃん/, `${name} に「わんちゃん」がありません:\n${text}`);
  }
});

test('休眠フォローには配信停止の導線がある', () => {
  // 営業色のある配信なので、止める手段を必ず同梱する（spec 2-3）
  const [, message] = MESSAGES.find(([n]) => n === '休眠フォロー');
  assert.match(visibleText(message).join('\n'), /不要な方/);
});

test('顧客名は文面に差し込まれるが、ログ用の id は混ざらない', () => {
  for (const [name, message] of MESSAGES) {
    const text = visibleText(message).join('\n');
    assert.match(text, /山田様/, `${name} に宛名がありません`);
    assert.ok(!/customer=/.test(text), `${name} に内部 id が混ざっています`);
  }
});

// ---- 本文の書き換え（管理画面から）----
// 宛名・ボタン・予約の詳細は構造として残り、本文だけが置き換わることを見る

const flexTexts = (msg) => JSON.stringify(msg.contents);

test('bodyText を渡すと本文だけが置き換わる', () => {
  for (const [label, build, fixed] of [
    ['前々日確認', () => buildPreReminderMessage({ ...args, bodyText: '独自の本文です' }), 'ご都合はいかがでしょうか'],
    ['来店フォロー', () => buildAfterVisitMessage({ ...args, bodyText: '独自の本文です' }), '元気にしています'],
    ['休眠フォロー', () => buildDormantMessage({ ...args, bodyText: '独自の本文です' }), '今後この案内が不要な方はこちら'],
    ['誕生日', () => buildBirthdayMessage({ ...args, bodyText: '独自の本文です' }), 'クーポンを見る'],
  ]) {
    const s = flexTexts(build());
    assert.match(s, /独自の本文です/, label);
    assert.match(s, /山田様/, `${label}: 宛名は残る`);
    assert.match(s, new RegExp(fixed), `${label}: 固定部は残る`);
  }
});

test('空行で段落が分かれ、2段落目からは間隔が付く', () => {
  const msg = buildDormantMessage({ ...args, bodyText: '一段落目\n\n二段落目' });
  const body = msg.contents.body.contents;
  const paras = body.filter((n) => /段落目/.test(n.text ?? ''));
  assert.equal(paras.length, 2);
  assert.equal(paras[0].margin, undefined);
  assert.equal(paras[1].margin, 'md');
});
