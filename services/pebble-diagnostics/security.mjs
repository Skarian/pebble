import {createHmac, randomBytes, timingSafeEqual} from 'node:crypto';

export const ADMIN_COOKIE = '__Host-pebble_admin';

function signature(secret, value) {
  return createHmac('sha256', secret).update(value).digest();
}

export function newSession(secret, authVersion, now = Date.now()) {
  const session = {
    exp: now + 12 * 60 * 60 * 1000,
    version: authVersion,
    csrf: randomBytes(24).toString('base64url'),
  };
  const value = Buffer.from(JSON.stringify(session)).toString('base64url');
  return {session, value: `${value}.${signature(secret, value).toString('base64url')}`};
}

export function readSession(cookieHeader, secret, authVersion, now = Date.now()) {
  const raw = String(cookieHeader || '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${ADMIN_COOKIE}=`))?.slice(ADMIN_COOKIE.length + 1);
  const [value, supplied] = String(raw || '').split('.');
  if (!value || !supplied) return null;
  let expected;
  try { expected = Buffer.from(supplied, 'base64url'); } catch { return null; }
  const actual = signature(secret, value);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const session = JSON.parse(Buffer.from(value, 'base64url').toString());
    return Number.isSafeInteger(session.exp) && session.exp > now
      && session.version === authVersion && typeof session.csrf === 'string' ? session : null;
  } catch { return null; }
}

export function sameSecret(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

export function setSessionCookie(value) {
  return `${ADMIN_COOKIE}=${value}; Path=/; Max-Age=43200; Secure; HttpOnly; SameSite=Strict`;
}

export function clearSessionCookie() {
  return `${ADMIN_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`;
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}
