/* Wysyłka maili przez zwykły serwer pocztowy (SMTP) — bez zewnętrznych usług.
   Workers łączą się po TCP (cloudflare:sockets): port 465 = SSL/TLS, 587 = STARTTLS. Port 25 jest w Cloudflare zablokowany. */
import { connect } from 'cloudflare:sockets';

const enc = new TextEncoder();
const b64 = s => { const b = enc.encode(s); let out = ''; for (let i = 0; i < b.length; i += 0x8000) out += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(out); };
const wrap76 = s => s.replace(/.{1,76}/g, '$&\r\n');
const header = s => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`;

export function buildMessage({ from, fromName, to, subject, text, html, domain }) {
  const boundary = 'b' + crypto.randomUUID().replace(/-/g, '');
  return [
    `From: ${fromName ? header(fromName) + ' ' : ''}<${from}>`,
    `To: <${to}>`,
    `Subject: ${header(subject)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(b64(text)),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(b64(html)),
    `--${boundary}--`,
    ''
  ].join('\r\n');
}

/* cfg: { host, port, secure: 'ssl' | 'starttls' | 'none', user, pass, from, fromName } */
export async function smtpSend(cfg, { to, subject, text, html }) {
  const secure = cfg.secure || (+cfg.port === 465 ? 'ssl' : 'starttls');
  let socket = connect({ hostname: cfg.host, port: +cfg.port }, { secureTransport: secure === 'ssl' ? 'on' : secure === 'starttls' ? 'starttls' : 'off', allowHalfOpen: false });
  let reader = socket.readable.getReader(), writer = socket.writable.getWriter();
  const dec = new TextDecoder(); let buf = '';

  // odpowiedź serwera: linie "250-…" aż do "250 …"
  const reply = async () => {
    for (;;) {
      const lines = buf.split('\r\n');
      for (let i = 0; i < lines.length - 1; i++) if (/^\d{3}(?: |$)/.test(lines[i])) {
        buf = lines.slice(i + 1).join('\r\n');
        return { code: +lines[i].slice(0, 3), text: lines.slice(0, i + 1).join('\n') };
      }
      const { value, done } = await reader.read();
      if (done) throw new Error('Serwer poczty zamknął połączenie.');
      buf += dec.decode(value, { stream: true });
    }
  };
  const write = s => writer.write(enc.encode(s + '\r\n'));
  const step = async (line, ok, hide) => {
    if (line !== null) await write(line);
    const r = await reply();
    if (!ok.includes(r.code)) throw new Error(`Serwer poczty odrzucił ${hide || (line || 'połączenie').split(' ')[0]}: ${r.text.slice(0, 200)}`);
    return r;
  };

  const run = async () => {
    await step(null, [220]);
    let ehlo = await step('EHLO plusoneapp.pl', [250]);
    if (secure === 'starttls') {
      await step('STARTTLS', [220]);
      reader.releaseLock(); writer.releaseLock();
      socket = socket.startTls();
      reader = socket.readable.getReader(); writer = socket.writable.getWriter();
      ehlo = await step('EHLO plusoneapp.pl', [250]);
    }
    if (cfg.user) {
      if (/AUTH[ =][^\n]*PLAIN/i.test(ehlo.text) && !/AUTH[ =][^\n]*LOGIN/i.test(ehlo.text)) {
        await step('AUTH PLAIN ' + b64(`\0${cfg.user}\0${cfg.pass}`), [235], 'logowanie (login lub hasło)');
      } else {
        await step('AUTH LOGIN', [334]);
        await step(b64(cfg.user), [334], 'login');
        await step(b64(cfg.pass || ''), [235], 'logowanie (login lub hasło)');
      }
    }
    await step(`MAIL FROM:<${cfg.from}>`, [250], 'nadawcę');
    await step(`RCPT TO:<${to}>`, [250, 251], 'odbiorcę');
    await step('DATA', [354]);
    const msg = buildMessage({ from: cfg.from, fromName: cfg.fromName, to, subject, text, html, domain: cfg.from.split('@')[1] || 'plusoneapp.pl' });
    await write(msg.replace(/^\./gm, '..') + '\r\n.');
    await step(null, [250], 'wiadomość');
    // grzeczne pożegnanie: czekamy chwilę na "221", zanim zamkniemy połączenie
    await write('QUIT').catch(() => {});
    await Promise.race([reply().catch(() => {}), new Promise(r => setTimeout(r, 1500))]);
  };

  try {
    await Promise.race([run(), new Promise((_, no) => setTimeout(() => no(new Error('Serwer poczty nie odpowiada (20 s).')), 20000))]);
  } finally {
    try { socket.close(); } catch {}
  }
}
