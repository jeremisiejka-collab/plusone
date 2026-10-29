"""Generuje ciemny arkusz (tryb nocny) dla modułów 3D z ich style.css: każdą deklarację z kolorem powtarza pod
html.night z kolorem o odwróconej jasności (ten sam odcień). Mocne kolory (róż marki, statusy) zostają bez zmian,
cienie zostają ciemne. Uruchom: python3 pipeline/venue3d/night_css.py  →  public/admin/moduly/<moduł>/night.css"""
import re, colorsys, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2] / 'public/admin/moduly'
NAMED = {'white': 'ffffff', 'black': '000000'}
COLOR = re.compile(r'#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b|\b(white|black)\b|rgba?\(([^)]*)\)')
SHADOW = ('box-shadow', 'text-shadow')

def parse(m):
    if m.group(1):
        h = m.group(1)
        if len(h) in (3, 4): h = ''.join(c * 2 for c in h)
        r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
        a = int(h[6:8], 16) / 255 if len(h) == 8 else 1
    elif m.group(2):
        h = NAMED[m.group(2)]; r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)); a = 1
    else:
        p = [x.strip() for x in m.group(3).replace('/', ',').split(',')]
        r, g, b = (float(x) / 255 for x in p[:3]); a = float(p[3]) if len(p) > 3 else 1
    return r, g, b, a

def fmt(r, g, b, a):
    s = '#%02x%02x%02x' % tuple(round(max(0, min(1, v)) * 255) for v in (r, g, b))
    return s if a >= .999 else s + '%02x' % round(a * 255)

def night(r, g, b, a, shadow=False):
    if shadow: return fmt(0, 0, 0, min(1, a * 2.2))
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    if s > .45 and .3 < l < .78: return fmt(r, g, b, a)          # róż marki, statusy, akcenty
    if l > .5: nl = .075 + (1 - l) * .9                              # jasne tła → ciemne
    else: nl = min(.93, .97 - l * .55)                               # ciemny tekst → jasny
    nr, ng, nb = colorsys.hls_to_rgb(h, nl, min(s, .35 if l > .5 else .25))
    return fmt(nr, ng, nb, a)

def convert(value, prop):
    return COLOR.sub(lambda m: night(*parse(m), shadow=prop in SHADOW), value)

def blocks(css):
    i, out = 0, []
    while i < len(css):
        j = css.find('{', i)
        if j < 0: break
        sel = css[i:j].strip(); depth, k = 1, j + 1
        while depth and k < len(css):
            depth += {'{': 1, '}': -1}.get(css[k], 0); k += 1
        out.append((sel, css[j + 1:k - 1])); i = k
    return out

def rules(css, prefix='html.night '):
    out = []
    for sel, body in blocks(css):
        if sel.startswith('@media'):
            inner = rules(body, prefix)
            if inner: out.append(sel + '{' + ''.join(inner) + '}')
            continue
        if sel.startswith('@'): continue                              # @font-face, @keyframes
        decls = []
        for d in body.split(';'):
            if ':' not in d: continue
            prop, val = d.split(':', 1); prop = prop.strip()
            if prop.startswith('--') or not COLOR.search(val): continue
            if prop in ('outline', 'outline-color'): continue
            decls.append(prop + ':' + convert(val.strip(), prop))
        if decls:
            def one(x):
                x = x.strip()
                if x.startswith(':root'): return 'html.night' + x[5:]
                if re.match(r'html\b', x): return 'html.night' + x[4:]
                return prefix + x
            sels = ','.join(one(x) for x in sel.split(','))
            out.append(sels + '{' + ';'.join(decls) + '}')
    return out

HEAD = ('/* WYGENEROWANE przez pipeline/venue3d/night_css.py z style.css — nie edytuj ręcznie. Tryb nocny włącza ../night.js (html.night). */\n'
        'html.night{color-scheme:dark;--ink:#e6edf5;--muted:#93a0ad;--line:#232d38}\n')
for mod in ('expo-map', 'venue-3d'):
    css = (ROOT / mod / 'style.css').read_text()
    (ROOT / mod / 'night.css').write_text(HEAD + '\n'.join(rules(css)) + '\n')
    print(mod, len(rules(css)), 'reguł')
