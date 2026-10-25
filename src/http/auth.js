// 管理画面（Basic 認証）と取り込み API（Bearer トークン）の認証ミドルウェア。
// 資格情報が未設定の環境では該当機能ごと無効化する（誤って無認証公開しない）。
import { createHash, timingSafeEqual } from 'node:crypto';

// 両方を固定長のハッシュにしてから比べる。そのまま比べると長さが違う時点で
// 返ってしまい、応答時間の差からパスワードの長さが分かる
function safeEqual(a, b) {
  const digest = (v) => createHash('sha256').update(String(v)).digest();
  return timingSafeEqual(digest(a), digest(b));
}

export function basicAuth({ user, password, realm = 'admin' }) {
  return (req, res, next) => {
    if (!user || !password) {
      return res.status(503).json({ error: 'admin_disabled', message: 'ADMIN_USER / ADMIN_PASSWORD が未設定です' });
    }
    const header = req.headers.authorization ?? '';
    const [scheme, encoded] = header.split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString();
      const sep = decoded.indexOf(':');
      const u = decoded.slice(0, sep);
      const p = decoded.slice(sep + 1);
      if (sep > 0 && safeEqual(u, user) && safeEqual(p, password)) {
        return next();
      }
    }
    res.set('WWW-Authenticate', `Basic realm="${realm}", charset="UTF-8"`);
    return res.status(401).json({ error: 'unauthorized' });
  };
}

export function bearerAuth({ token }) {
  return (req, res, next) => {
    if (!token) {
      return res.status(503).json({ error: 'import_disabled', message: 'INGEST_API_TOKEN が未設定です' });
    }
    const header = req.headers.authorization ?? '';
    const [scheme, value] = header.split(' ');
    if (scheme === 'Bearer' && value && safeEqual(value, token)) {
      return next();
    }
    return res.status(401).json({ error: 'unauthorized' });
  };
}
