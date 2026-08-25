// EPARK の仮受付に添える院内メモの本文。
// ここが空になると無名の仮受付に戻る（枠は押さえられる）ので、壊れても事故にはならない。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detailsText, nameParts, registerFields } from '../src/epark/details.js';

const row = {
  id: 12,
  customer_name: '山田 花子',
  phone_norm: '09012345678',
  pet_name: 'ポチ',
  menu: 'カットコース',
};

test('お名前・ペット・電話番号・コース・予約番号を1行にまとめる', () => {
  assert.equal(
    detailsText(row),
    'LINE予約 / 山田 花子 様 / ポチちゃん / 090-1234-5678 / カットコース / res=12'
  );
});

test('携帯番号はハイフンを戻す。桁が想定外ならそのまま出す', () => {
  assert.match(detailsText(row), /090-1234-5678/);
  assert.match(detailsText({ ...row, phone_norm: '0312345678' }), /0312345678/);
});

test('欠けている項目は飛ばす', () => {
  assert.equal(
    detailsText({ id: 3, customer_name: '田中', pet_name: null, phone_norm: null, menu: '' }),
    'LINE予約 / 田中 様 / res=3'
  );
});

test('載せる中身が無ければ null（無名の仮受付に戻す）', () => {
  assert.equal(detailsText({}), null);
  assert.equal(detailsText(null), null);
});

test('メモ欄に収まる長さで切る', () => {
  const long = detailsText({ ...row, menu: 'あ'.repeat(500) });
  assert.ok(long.length <= 200, `長すぎる: ${long.length}`);
  // 切られても、誰の予約かは先頭に残る
  assert.match(long, /^LINE予約 \/ 山田 花子 様/);
});

// ---- 顧客情報の欄に入れる値 ----

test('氏名は最初の空白で姓と名に割る', () => {
  assert.deepEqual(nameParts({ customer_name: '山田 花子' }), { lastName: '山田', firstName: '花子' });
  assert.deepEqual(nameParts({ customer_name: '山田　花子' }), { lastName: '山田', firstName: '花子' },
    '全角スペースでも割る');
  assert.deepEqual(nameParts({ customer_name: '佐藤 花子 様' }), { lastName: '佐藤', firstName: '花子 様' },
    '2つ目以降の空白は名のまま残す');
});

test('空白の無い氏名は、全部を姓に入れる（名は空）', () => {
  assert.deepEqual(nameParts({ customer_name: '田中花子' }), { lastName: '田中花子', firstName: '' });
  assert.deepEqual(nameParts({}), { lastName: '', firstName: '' });
});

test('登録画面に打ち込む値をまとめて作る', () => {
  assert.deepEqual(registerFields(row), {
    details: 'LINE予約 / 山田 花子 様 / ポチちゃん / 090-1234-5678 / カットコース / res=12',
    lastName: '山田',
    firstName: '花子',
    // EPARK の指定どおりハイフン無しの半角数字
    phone: '09012345678',
  });
});

test('載せる中身が無ければ null（無名の仮受付に戻す）', () => {
  assert.equal(registerFields({}), null);
});
