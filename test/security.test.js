// 応答ヘッダと、他サイトからの書き込みの拒否。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { securityHeaders, rejectCrossSite } from '../src/http/security.js';

function call(mw, { path = '/', method = 'GET', headers = {} } = {}) {
  const res = {
    headers: {}, statusCode: null, body: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const req = { path, method, get: (k) => lower[k.toLowerCase()] };
  let next = false;
  mw(req, res, () => { next = true; });
  return { res, next };
}

// ---- ヘッダ ----

test('全ルートに nosniff（認証なしで配る写真を HTML として解釈させない）', () => {
  for (const path of ['/', '/sns-media/abc.jpg', '/liff/', '/mock/', '/api/admin/customers']) {
    const { res, next } = call(securityHeaders(), { path });
    assert.equal(res.headers['x-content-type-options'], 'nosniff', path);
    assert.equal(next, true);
  }
});

test('管理画面と管理 API だけ、枠への埋め込みを禁止する（クリックジャッキング対策）', () => {
  for (const path of ['/mock', '/mock/', '/mock/index.html', '/api/admin', '/api/admin/reservations']) {
    const { res } = call(securityHeaders(), { path });
    assert.equal(res.headers['x-frame-options'], 'DENY', path);
    assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/, path);
  }
});

test('LIFF 画面には埋め込み禁止を付けない（LINE の中で開くため壊さない）', () => {
  for (const path of ['/liff/', '/liff/reserve.html', '/health', '/mockup']) {
    const { res } = call(securityHeaders(), { path });
    assert.equal(res.headers['x-frame-options'], undefined, path);
    assert.equal(res.headers['content-security-policy'], undefined, path);
  }
});

test('CSP は script-src を縛らない（管理画面は1枚の HTML にスクリプトを直書きしている）', () => {
  const { res } = call(securityHeaders(), { path: '/mock/' });
  assert.doesNotMatch(res.headers['content-security-policy'], /script-src|default-src/);
});

// ---- 他サイトからの書き込み ----

test('管理画面（同じオリジン）からの書き込みは通す', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const { next } = call(rejectCrossSite(), { method, headers: { 'Sec-Fetch-Site': 'same-origin' } });
    assert.equal(next, true, method);
  }
});

test('ブラウザ以外（curl・GitHub Actions の EPARK 反映）はヘッダが無いので通す', () => {
  const { next } = call(rejectCrossSite(), { method: 'POST' });
  assert.equal(next, true);
});

test('他サイトから送られた書き込みは 403（保存された Basic 認証を悪用させない）', () => {
  for (const site of ['cross-site', 'same-site']) {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const { res, next } = call(rejectCrossSite(), { method, headers: { 'Sec-Fetch-Site': site } });
      assert.equal(next, false, `${site} ${method}`);
      assert.equal(res.statusCode, 403);
      assert.equal(res.body.error, 'cross_site_request');
    }
  }
});

test('読み取り（GET / HEAD / OPTIONS）は他サイトからでも通す（何も変えないため）', () => {
  for (const method of ['GET', 'HEAD', 'OPTIONS']) {
    const { next } = call(rejectCrossSite(), { method, headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(next, true, method);
  }
});
