#!/usr/bin/env python3
"""Laedt den Wissenskatalog MIT Voyage-Embeddings per PostgREST (anon + temp. Insert-Policy).
Nur der Wissenskatalog ist RAG (Vektor); Leistungen/Material laufen ueber Trigram.

Voraussetzungen:
  - export VOYAGE_API_KEY (aus ~/.synclaro/.env)
  - export ANON  (Aurora anon key)
Aufruf:
  python3 seed_wissen_embed.py 01_wissen.json
"""
import json, os, sys, urllib.request

VOYAGE_API_KEY = os.environ["VOYAGE_API_KEY"]
ANON = os.environ["ANON"]
EMBED_MODEL = os.environ.get("EMBED_MODEL", "voyage-4-large")
PROJECT_URL = "https://jobarrwnqnarahdpchfb.supabase.co"
TABLE = "angebotsworkflow_wissen"

def voyage(texts, input_type):
    body = json.dumps({"input": texts, "model": EMBED_MODEL, "input_type": input_type}).encode()
    req = urllib.request.Request("https://api.voyageai.com/v1/embeddings", data=body,
        headers={"Authorization": f"Bearer {VOYAGE_API_KEY}", "Content-Type": "application/json"})
    d = json.load(urllib.request.urlopen(req, timeout=120))
    return [x["embedding"] for x in d["data"]]

def vec_literal(v):
    return "[" + ",".join(str(round(float(x), 7)) for x in v) + "]"

def post(rows):
    body = json.dumps(rows, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(f"{PROJECT_URL}/rest/v1/{TABLE}", data=body, method="POST",
        headers={"apikey": ANON, "Authorization": f"Bearer {ANON}",
                 "Content-Type": "application/json", "Prefer": "return=minimal"})
    r = urllib.request.urlopen(req, timeout=120)
    return r.status

def main():
    rows = json.load(open(sys.argv[1], encoding="utf-8"))
    out = []
    B = 64
    for i in range(0, len(rows), B):
        batch = rows[i:i+B]
        texts = [(r.get("titel", "") + "\n" + r.get("inhalt", ""))[:8000] for r in batch]
        embs = voyage(texts, "document")
        for r, e in zip(batch, embs):
            r2 = {k: r.get(k) for k in ("gewerk", "typ", "titel", "inhalt", "tags", "metadata")}
            r2["embedding"] = vec_literal(e)
            out.append(r2)
        print(f"  embedded {min(i+B, len(rows))}/{len(rows)}")
    # in Haeppchen posten
    P = 50
    for i in range(0, len(out), P):
        st = post(out[i:i+P])
        print(f"  posted {min(i+P, len(out))}/{len(out)} -> HTTP {st}")
    print(f"OK: {len(out)} Wissens-Eintraege mit Embeddings geladen.")

if __name__ == "__main__":
    main()
