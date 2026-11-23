/* Strażnik pobierania: po każdym przebiegu sprawdza public/data/events.json.
   Wypisuje listę problemów (puste = wszystko działa). W GitHub Actions wynik trafia do zgłoszenia (issue)
   „Pobieranie wydarzeń: problem”, które zamyka się samo, gdy problemy znikną.
   Progi: źródło z błędem, źródło z liczbą wydarzeń poniżej połowy normy, za mało wydarzeń razem. */
import { readFile } from 'node:fs/promises';

const MIN = { going: 500, ebilet: 1500, ra: 40, go2warsaw: 80, sport: 30, allevents: 500, pik: 80, kluby: 60 };
const TOTAL = 4000;

const d = JSON.parse(await readFile(new URL('../../public/data/events.json', import.meta.url), 'utf8'));
const out = [];
for (const [name, r] of Object.entries(d.sources || {})) {
  if (!r.ok) out.push(`- **${name}**: błąd „${r.error}” (zostawiono ${r.kept} wydarzeń z poprzedniego przebiegu)`);
  else if (MIN[name] && r.count < MIN[name] / 2) out.push(`- **${name}**: tylko ${r.count} wydarzeń (zwykle ponad ${MIN[name]})`);
}
for (const name of Object.keys(MIN)) if (!d.sources?.[name]) out.push(`- **${name}**: źródło nie zostało uruchomione`);
if (d.count < TOTAL) out.push(`- razem tylko ${d.count} wydarzeń (zwykle ponad ${TOTAL})`);
console.log(out.join('\n'));
