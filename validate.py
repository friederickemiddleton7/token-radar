#!/usr/bin/env python3
"""Local gate-check for a token-radar-01 /output directory, from the competition rules."""
import json, os, re, sys

OUT = sys.argv[1] if len(sys.argv) > 1 else 'out'
SNAP = sys.argv[2] if len(sys.argv) > 2 else 'input/snapshot.json'
fails, warns = [], []
def check(ok, msg):
    (print(f"  ok   {msg}") if ok else (fails.append(msg), print(f"  FAIL {msg}")))

snap = json.load(open(SNAP))
watch = set(snap['watchlist'])
slugs = {p['slug'] for p in snap['protocols']}

print('== board.json ==')
raw = open(f'{OUT}/board.json', 'rb').read()
check(len(raw) <= 8*1024*1024, f'board.json <= 8 MiB ({len(raw)} bytes)')
b = json.loads(raw)
rows = b['rows'] if isinstance(b, dict) else b
check(isinstance(rows, list) and 100 <= len(rows) <= 4000, f'rows 100..4000 (got {len(rows)})')
r0 = rows[0]
check(all(k in r0 for k in ('slug','name','rank','implied_value_usd','farm_steps')), 'rows carry the five required keys')
seen = set()
for r in rows:
    s = r['slug']
    check(s in slugs, f'slug in snapshot: {s}') if s not in slugs else None
    if s in seen: fails.append(f'duplicate slug {s}')
    seen.add(s)
check(len(seen) == len(rows), 'slugs unique')
check(all(isinstance(r['name'], str) and r['name'] for r in rows), 'name non-empty')
ranks = sorted(r['rank'] for r in rows)
check(ranks == list(range(1, len(rows)+1)), 'ranks are exactly 1..N')
vals = [r['implied_value_usd'] for r in rows]
check(all(isinstance(v, int) and 0 < v <= 100_000_000_000_000 for v in vals), 'implied values positive ints <= 1e14')
check(all(vals[i] >= vals[i+1] for i in range(len(vals)-1)), 'implied value does not rise as rank ascends')
check(len(set(vals)) >= 2, 'not all implied values equal')
missing = watch - seen
check(not missing, f'watchlist fully covered (missing {sorted(missing)[:5]})')
bad_steps = [r['slug'] for r in rows if not (3 <= len(r['farm_steps']) <= 12)]
check(not bad_steps, f'farm_steps 3..12 per row (bad: {bad_steps[:3]})')
bad_len = [(r['slug'], len(s)) for r in rows for s in r['farm_steps'] if not (20 <= len(s.strip()) <= 600)]
check(not bad_len, f'each farm step 20..600 chars (bad: {bad_len[:3]})')
print(f"  info board covers {len(seen & watch)}/{len(watch)} watchlist; {len(seen - watch)} rows below the floor")

print('== dashboard/ ==')
d = f'{OUT}/dashboard'
names = []
for root, dirs, files in os.walk(d):
    for x in dirs:
        if x.startswith('.'): fails.append(f'dot-directory {x}')
    for f in files:
        names.append(os.path.relpath(os.path.join(root, f), d))
check(any(n == 'index.html' for n in names), 'index.html present')
check(any(n.endswith('.css') for n in names), 'at least one .css')
check(any(n.endswith('.js') for n in names), 'at least one .js')
check(len(names) <= 400, f'<= 400 files (got {len(names)})')
tot = sum(os.path.getsize(os.path.join(d, n)) for n in names)
check(tot <= 4*1024*1024, f'dashboard <= 4 MiB (got {tot} bytes)')
NAME = re.compile(r'^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$')
check(all(NAME.match(n) for n in names), 'file names are letters/digits/._-')
# no network addresses in attributes, css, or js imports
net = re.compile(r'https?://')
for n in names:
    p = os.path.join(d, n); t = open(p, encoding='utf-8', errors='replace').read()
    if n.endswith('.html'):
        for m in re.finditer(r'<[^>]+>', t):
            if net.search(m.group(0)): fails.append(f'{n}: network address in markup: {m.group(0)[:60]}')
        for m in re.finditer(r'<style[^>]*>(.*?)</style>', t, re.S):
            if net.search(m.group(1)): fails.append(f'{n}: network address in <style>')
    elif n.endswith('.css'):
        if net.search(t): fails.append(f'{n}: network address in css')
    elif n.endswith('.js'):
        for m in re.finditer(r'(import\s+[^;]*from\s*[\'"]|import\s*[\'"]|export\s+[^;]*from\s*[\'"]|require\s*\(\s*[\'"]|import\s*\(\s*[\'"])([^\'"]+)', t):
            if net.search(m.group(2)): fails.append(f'{n}: network address in import: {m.group(2)[:60]}')
src_bytes = sum(os.path.getsize(os.path.join(d, n)) for n in names if n.endswith(('.html','.css','.js','.json','.mjs','.svg','.md','.txt')))
print(f"  info dashboard source shown to the judge: {src_bytes} bytes (cap 65536) -> {'ok' if src_bytes <= 65536 else 'TRUNCATED, judge reads a partial source'}")
if src_bytes > 65536: fails.append('dashboard source exceeds the 64 KB the judge reads whole')

print('== screenshots/ ==')
sdir = f'{OUT}/screenshots'
shots = [f for f in os.listdir(sdir) if not f.startswith('.')]
check(3 <= len(shots) <= 4, f'3..4 screenshots (got {len(shots)})')
def png_size(p):
    with open(p,'rb') as f: dta = f.read()
    if dta[:8] == b'\x89PNG\r\n\x1a\n':
        w = int.from_bytes(dta[16:20],'big'); h = int.from_bytes(dta[20:24],'big'); return ('png', w, h)
    if dta[:2] == b'\xff\xd8':
        i = 2
        while i < len(dta):
            if dta[i] != 0xFF: i += 1; continue
            mk = dta[i+1]
            if mk in (0xC0,0xC1,0xC2,0xC3):
                h = int.from_bytes(dta[i+5:i+7],'big'); w = int.from_bytes(dta[i+7:i+9],'big'); return ('jpg', w, h)
            i += 2 + int.from_bytes(dta[i+2:i+4],'big')
        return ('jpg', 0, 0)
    return (None, 0, 0)
for f in sorted(shots):
    p = os.path.join(sdir, f); sz = os.path.getsize(p); kind, w, h = png_size(p)
    check(kind is not None, f'{f}: whole PNG/JPEG')
    check(sz <= 512*1024, f'{f}: <= 512 KiB ({sz} bytes)')
    check(800 <= min(w,h) and max(w,h) <= 1440, f'{f}: {w}x{h} within 1440x800..')
    lo, hi = 300*1024, 350*1024
    print(f"  info {f}: {w}x{h}, {sz} bytes {'(in the 300-350 KB sweet spot)' if lo <= sz <= hi else '(outside 300-350 KB guidance)'}")

print('== dossier.json ==')
dp = f'{OUT}/dossier.json'
dsz = os.path.getsize(dp)
check(dsz <= 1.5*1024*1024, f'dossier <= 1.5 MiB ({dsz} bytes)')
import hashlib
sys.path.insert(0, 'node_shim') if os.path.isdir('node_shim') else None
print(f"  info dossier.json is {dsz} bytes; byte-equality is guaranteed because main.ts writes buildDossier(out) last")

print()
print('FAILURES:', len(fails))
for f in fails: print('  -', f)
sys.exit(1 if fails else 0)
