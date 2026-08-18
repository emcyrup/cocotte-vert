import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nightsOf, stayLabel } from '../src/reservations/stay.js';

test('入室日時と退室日から泊数を数える', () => {
  assert.equal(nightsOf({ reservedAt: '2026-08-20T05:00:00.000Z', checkoutDate: '2026-08-22' }), 2);
  // 月をまたいでも数え違えない
  assert.equal(nightsOf({ reservedAt: '2026-08-30T05:00:00.000Z', checkoutDate: '2026-09-02' }), 3);
});

test('入室が夜でも、JST の日付で数える（UTC だと翌日になる時刻）', () => {
  // 2026-08-20T14:00Z = JST 8/20 23:00。UTC の日付で数えると1泊足りなくなる
  assert.equal(nightsOf({ reservedAt: '2026-08-20T14:00:00.000Z', checkoutDate: '2026-08-22' }), 2);
});

test('宿泊でなければ null', () => {
  assert.equal(nightsOf({ reservedAt: '2026-08-20T05:00:00.000Z', checkoutDate: null }), null);
  // 退室日が入室日以前のものは数えない
  assert.equal(nightsOf({ reservedAt: '2026-08-20T05:00:00.000Z', checkoutDate: '2026-08-20' }), null);
  assert.equal(nightsOf({ reservedAt: 'こわれた日時', checkoutDate: '2026-08-22' }), null);
  assert.equal(stayLabel({ reservedAt: '2026-08-20T05:00:00.000Z', checkoutDate: null }), null);
});

test('確認にもメモにも同じ言い方で出す', () => {
  assert.equal(
    stayLabel({ reservedAt: '2026-08-20T05:00:00.000Z', checkoutDate: '2026-08-22' }),
    '2泊（8月22日(土) 退室予定）'
  );
});
