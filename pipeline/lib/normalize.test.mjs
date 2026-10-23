import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clean, cleanEventText, makeEvent, stripEmoji } from './normalize.mjs';

test('usuwa emoji złożone, flagi, modyfikatory i klawisze bez resztek', () => {
  const samples = ['\u{1F3A4}', '\u{1F1F5}\u{1F1F1}', '\u{1F44D}\u{1F3FD}', '\u{1F469}\u{1F3FD}\u200D\u{1F4BB}', '\u2764\uFE0F', '1\uFE0F\u20E3', '#\u20E3', '\u{1F3F4}\u{E0067}\u{E0062}\u{E007F}'];
  for (const sample of samples) assert.equal(stripEmoji(`Koncert ${sample} jutro`), 'Koncert jutro');
});

test('zachowuje polski tekst, liczby i zwykłe symbole tekstowe', () => {
  const text = 'Łódź – +1, 26.10, 19:00, 99 zł; © ® ™ #1 *2 →';
  assert.equal(stripEmoji(text), text);
});

test('czyści emoji także po dekodowaniu encji HTML', () => {
  assert.equal(clean('<b>Koncert</b> &#127908; &#x1F3A4; &amp;#x1F3A4; jutro'), 'Koncert jutro');
  assert.equal(clean('Scena &#x104; &#260;'), 'Scena Ą Ą');
  assert.doesNotThrow(() => clean('&#99999999999999; &#xD800;'));
});

test('nowy import usuwa emoji z tytułu i opisu', () => {
  const event = makeEvent({id:'test', title:'Koncert \u{1F3A4}', description:'Zapraszamy \u2728', source:'test', url:'https://example.test/ticket', city:'Warszawa'});
  assert.equal(event.title, 'Koncert');
  assert.equal(event.description, 'Zapraszamy');
});

test('czyści zachowane dane bez zmiany identyfikatorów, dat i linków', () => {
  const event = {id:'test', title:'Koncert \u{1F3A4}', description:'Opis \u2728', city:'Łódź', venue:null, address:'Klub \u{1F3B5}', tags:['Rock \u{1F3B8}'], artists:['Zespół \u{1F3A4}'], start:'2026-10-24T20:00', image:'https://example.test/\u{1F3A4}.jpg', links:[{url:'https://example.test/\u{1F3A4}'}]};
  const result = cleanEventText(event);
  assert.equal(result.title, 'Koncert');
  assert.equal(result.description, 'Opis');
  assert.equal(result.address, 'Klub');
  assert.deepEqual(result.tags, ['Rock']);
  assert.deepEqual(result.artists, ['Zespół']);
  for (const key of ['id','city','venue','start','image','links']) assert.deepEqual(result[key], event[key]);
  assert.equal(event.title, 'Koncert \u{1F3A4}');
});

test('publikowany katalog nie zawiera emoji w treściach wydarzeń', () => {
  const data = JSON.parse(readFileSync(new URL('../../public/data/events.json', import.meta.url)));
  for (const event of data.events) assert.deepEqual(cleanEventText(event), event, event.id);
});

test('interfejs używa ikon SVG zamiast systemowych emoji', () => {
  for (const path of ['../../public/index.html', '../../private/app.html', '../../public/admin.js', '../../public/premium.js']) {
    assert.doesNotMatch(readFileSync(new URL(path, import.meta.url), 'utf8'), /[\p{Emoji_Presentation}\uFE0F\u20E3]/u, path);
  }
});
