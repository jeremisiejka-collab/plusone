const UA = 'Mozilla/5.0 (compatible; plusone-events-bot/1.0; +https://github.com/jeremisiejka-collab/plusone)';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* fetch z timeoutem i ponawianiem (backoff 1s, 2s, 4s) */
export async function request(url, { method = 'GET', headers = {}, body, type = 'json', retries = 3, timeout = 30000 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        method, body,
        headers: { 'User-Agent': UA, 'Accept-Language': 'pl-PL,pl;q=0.9', ...headers },
        signal: AbortSignal.timeout(timeout)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
      return type === 'json' ? await res.json() : await res.text();
    } catch (e) {
      lastErr = e;
      if (i < retries) await sleep(1000 * 2 ** i);
    }
  }
  throw lastErr;
}

export { sleep };
