// 管理画面の保存型 XSS の回帰試験。
//
// お客様は LIFF の登録フォームや予約フォームで、名前・ご要望を自由に書ける。
// LINE の表示名もそのまま顧客名に入る。これらを管理画面が innerHTML で
// そのまま描くと、**スタッフが顧客一覧やカレンダーを開いた瞬間に、そのお客様が
// 書いたスクリプトが管理者の画面で動く**（全顧客の氏名・電話番号の持ち出し、
// 予約の承認＝お客様への LINE 送信まで、管理画面でできることは全部できる）。
// 実際に12の欄で起きていた（2026-10 の診断で発見・修正）。
//
// 欄ごとに「実行されたら印を付ける」文字列を返す偽の管理 API で画面を一通り開き、
// 印が1つも付かないことを確かめる。ブラウザが無い環境（CI など）では飛ばす。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

async function browserAvailable() {
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ executablePath: process.env.EPARK_BROWSER_PATH || undefined });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}
const skip = !(await browserAvailable()) && 'ブラウザ未導入';

const HTML = readFileSync(new URL('../src/mock/index.html', import.meta.url), 'utf8');
const mark = (tag) => `<img src=x onerror="(window.__xss=window.__xss||[]).push('${tag}')">`;

function fakeApi() {
  const today = new Date();
  const at = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 11, 0).toISOString();
  const staff = [{ id: 1, name: mark('staff.name'), active: true, line_user_id: null, line_linked: false, reservation_count: 0 }];
  return {
    '/staff': { staff },
    '/staff?all=1': { staff },
    '/customers': { customers: [{ id: 1, name: mark('customer.name'), phone_norm: '09000000000', line_linked: true, birthday: null, opt_out: false }] },
    '/customers/1/pets': { pets: [{ id: 1, name: mark('pet.name'), breed: mark('pet.breed'), birthday: null, notes: mark('pet.notes') }] },
    '/reservations': { reservations: [{
      id: 1, customer_id: 1, customer_name: mark('resv.customer_name'), reserved_at: at,
      menu: mark('resv.menu'), note: mark('resv.note'), status: 'confirmed', staff_id: 1,
      staff_name: mark('resv.staff_name'), duration_minutes: 60, confirmed_by_customer: false,
    }] },
    '/shift-requests': { requests: [{ id: 1, staff_name: mark('shift.name'), raw_text: mark('shift.raw'),
      reason: mark('shift.reason'), target_date: today.toISOString().slice(0, 10), kind: 'koukyu', status: 'pending' }] },
  };
}

test('お客様・スタッフが入力できる欄に HTML を入れても、管理画面でスクリプトが動かない', { skip, timeout: 60000 }, async () => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ executablePath: process.env.EPARK_BROWSER_PATH || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('dialog', (d) => d.dismiss().catch(() => {}));
    const api = fakeApi();
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.includes('/api/admin')) {
        const path = url.pathname.replace(/^.*\/api\/admin/, '');
        const body = api[path + url.search] ?? api[path] ?? {};
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
      }
      if (url.origin === 'http://mock.local') {
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: HTML });
      }
      return route.fulfill({ status: 404, body: '' });
    });

    await page.goto('http://mock.local/mock/');
    await page.waitForTimeout(1200);
    // 偽 API に繋がって「実運用モード」で描いていること（デモのままだと試験にならない）
    assert.equal(await page.evaluate(() => adminLive), true);

    for (const s of ['cal', 'resv', 'list', 'cust', 'shift', 'dash']) {
      await page.locator(`#nav button[data-s="${s}"]`).first().click().catch(() => {});
      await page.waitForTimeout(500);
    }
    // カルテ（氏名・電話・メモ・来店履歴）も開く
    for (const s of ['cust', 'list']) {
      await page.locator(`#nav button[data-s="${s}"]`).first().click().catch(() => {});
      await page.waitForTimeout(400);
      const link = page.locator('.cnlink:visible').first();
      if (await link.count()) { await link.click(); await page.waitForTimeout(700); break; }
    }
    assert.ok(await page.locator('#custbody .cust-hd').count(), 'カルテが開けていない（試験の前提が崩れた）');

    const fired = await page.evaluate(() => window.__xss || []);
    assert.deepEqual([...new Set(fired)].sort(), [], `スクリプトが動いた欄: ${[...new Set(fired)].join(', ')}`);

    // 消えたのではなく、文字として出ていること（エスケープされて見えている）
    const text = await page.locator('body').innerText();
    assert.match(text, /<img src=x onerror=/);
  } finally {
    await browser.close();
  }
});
