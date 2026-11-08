/* +1 — bezpieczeństwo: nagłówki dla każdej odpowiedzi Workera i limity zapytań do API.
   Nagłówki dla plików serwowanych bez Workera są w public/_headers (ta sama polityka). */

// Polityka treści: skrypty i style tylko z naszej domeny (plus wbudowane, bo strona i aplikacja to pojedyncze pliki HTML),
// obrazki wydarzeń i kafelki map z dowolnego https, zapytania tylko do nas, Nominatim i Overpass (mapa), ramki tylko nasze.
export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com",   // statystyki odwiedzin Cloudflare (Web Analytics)
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "media-src 'self' blob: https:",
  "connect-src 'self' https://nominatim.openstreetmap.org https://overpass-api.de https://cloudflareinsights.com",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'"
].join('; ');

const BASE = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Frame-Options': 'SAMEORIGIN',
  'Cross-Origin-Opener-Policy': 'same-origin',
  // aparat tylko dla skanera biletów; reszta wyłączona
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(self), payment=(), usb=(), interest-cohort=()'
};

export function withSecurityHeaders(res) {
  if (!res || res.status === 101) return res;
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(BASE)) if (!out.headers.has(k)) out.headers.set(k, v);
  if ((out.headers.get('Content-Type') || '').includes('text/html') && !out.headers.has('Content-Security-Policy')) out.headers.set('Content-Security-Policy', CSP);
  return out;
}

/* ---- limity zapytań: licznik w D1 na okno godzinowe; klucz = sesja (jeśli jest) albo adres IP ----
   Na wydarzeniu wiele osób ma ten sam IP (wi-fi obiektu), więc zalogowanych liczymy po sesji, nie po IP. */
const HOUR = 3600e3;
const RULES = [
  // [metoda, ścieżka, limit na godzinę, po czym liczyć]
  ['POST', '/api/auth/register', 10, 'ip'],
  ['POST', '/api/auth/login', 30, 'ip'],
  ['POST', '/api/auth/code', 20, 'ip'],
  ['POST', '/api/auth/verify', 30, 'ip'],
  ['POST', '/api/auth/forgot', 10, 'ip'],
  ['POST', '/api/auth/reset', 20, 'ip'],
  ['POST', '/api/invite/accept', 20, 'ip'],
  ['POST', '/api/ops/welcome-admins', 5, 'ip'],
  ['GET', '/api/crew/join', 120, 'ip'],
  ['POST', '/api/guide/notify', 30, 'who'],
  ['POST', '/api/crew/invite', 60, 'who'],
  ['POST', '/api/push/test', 10, 'who'],
  ['POST', '/api/admin/mail/test', 10, 'who'],
  ['POST', '/api/admin/newsletter', 5, 'who'],
  ['POST', '/api/admin/invites', 100, 'who'],
  ['POST', '/api/social/messages', 300, 'who'],
  ['POST', '/api/social/code', 20, 'who'],
  ['POST', '/api/org/guests', 500, 'who'],
  ['POST', '/api/t', 6000, 'who']   // statystyki odwiedzin: sygnał co 30 s + kliknięcia
];
const GENERAL = 1200; // każda inna zmiana danych (POST/PUT/PATCH/DELETE) na godzinę

const ipOf = req => req.headers.get('CF-Connecting-IP') || req.headers.get('X-Forwarded-For')?.split(',')[0].trim() || 'local';
async function short(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d).slice(0, 12)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/* zwraca null (można) albo liczbę sekund do odblokowania */
export async function rateLimit(env, req, path, method) {
  const write = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  const rule = RULES.find(([m, p]) => m === method && p === path);
  if (!rule && !write) return null;
  const [, , max, by] = rule || [method, '*', GENERAL, 'who'];
  const sid = (req.headers.get('Cookie') || '').match(/(?:^|;\s*)sid=([^;]+)/)?.[1];
  const who = by === 'who' && sid ? 's:' + await short(sid) : 'i:' + await short(ipOf(req));
  const key = (rule ? path : '*') + '|' + who, now = Date.now();
  try {
    const row = await env.DB.prepare(
      `INSERT INTO rate_limits (k, n, reset) VALUES (?1, 1, ?2)
       ON CONFLICT(k) DO UPDATE SET n = CASE WHEN reset <= ?3 THEN 1 ELSE n + 1 END, reset = CASE WHEN reset <= ?3 THEN ?2 ELSE reset END
       RETURNING n, reset`).bind(key, now + HOUR, now).first();
    if (Math.random() < 0.01) await env.DB.prepare('DELETE FROM rate_limits WHERE reset <= ?').bind(now).run();
    return row && row.n > max ? Math.max(1, Math.ceil((row.reset - now) / 1000)) : null;
  } catch (e) {
    return null; // brak tabeli (przed migracją) albo chwilowy błąd bazy — nie blokujemy ruchu
  }
}
