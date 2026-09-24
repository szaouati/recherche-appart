import fitz, re, json, sys
path = sys.argv[1]
doc = fitz.open(path)
out = []
vus = set()
for pageno, page in enumerate(doc):
    liens = []
    for l in page.get_links():
        uri = l.get('uri', '')
        if uri and '/ad/locations/' in uri:
            adid = uri.split('/ad/locations/')[1].split('?')[0]
            liens.append((l['from'].y0, l['from'].y1, adid))
    liens.sort()
    dedup = []
    for y0, y1, aid in liens:
        if dedup and dedup[-1][2] == aid:
            dedup[-1] = (min(dedup[-1][0], y0), max(dedup[-1][1], y1), aid)
        else:
            dedup.append((y0, y1, aid))
    blocks = page.get_text('blocks')
    for y0, y1, aid in dedup:
        if aid in vus:
            continue
        t = ' | '.join(b[4] for b in blocks if y0 - 3 <= b[1] <= y1 + 3)
        mp = re.search(r'(\d{2,4})\s*[€]', t)
        ms = re.search(r'(\d{1,3}(?:[.,]\d+)?)\s*m²', t)
        mr = re.search(r'(\d)\s*pi[eè]ce', t)
        if not (mp and ms):
            continue
        vus.add(aid)
        mf = re.search(r'[ÉE]tage\s*(\d+)', t)
        floor = 0 if re.search(r'\bRDC\b', t) else (int(mf.group(1)) if mf else None)
        mq = re.search(r'Paris\s*750\d\d\s*([^\n|]*)', t)
        out.append({
            'id': aid, 'price': int(mp.group(1)), 'surface': float(ms.group(1).replace(',', '.')),
            'rooms': int(mr.group(1)) if mr else None, 'floor': floor,
            'quartier': mq.group(1).strip() if mq else None,
            'meuble': 'Meubl' in t, 'balcon': 'Balcon' in t, 'terrasse': 'Terrasse' in t,
            'dernier': 'Dernier' in t, 'pro': 'Pro' in t,
        })
print(json.dumps(out, ensure_ascii=False))
