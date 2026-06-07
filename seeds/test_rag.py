#!/usr/bin/env python3
"""RAG-Test: embeddet eine Anfrage via Voyage (query) und ruft die match-RPC ueber PostgREST.
Zeigt, ob die semantische Suche die passenden Wissens-Eintraege findet.
  export VOYAGE_API_KEY ; export ANON
  python3 test_rag.py "Wasserrohr unter Kueche verlegen, Fliesenboden mit Fussbodenheizung aufstemmen"
"""
import json, os, sys, urllib.request

VOYAGE_API_KEY = os.environ["VOYAGE_API_KEY"]
ANON = os.environ["ANON"]
EMBED_MODEL = os.environ.get("EMBED_MODEL", "voyage-4-large")
PROJECT_URL = "https://jobarrwnqnarahdpchfb.supabase.co"

def voyage_query(text):
    body = json.dumps({"input": [text], "model": EMBED_MODEL, "input_type": "query"}).encode()
    req = urllib.request.Request("https://api.voyageai.com/v1/embeddings", data=body,
        headers={"Authorization": f"Bearer {VOYAGE_API_KEY}", "Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=60))["data"][0]["embedding"]

def rpc_match(vec, k=6, gewerk=None):
    payload = {"query_embedding": "[" + ",".join(str(round(x, 7)) for x in vec) + "]",
               "match_count": k, "filter_gewerk": gewerk}
    body = json.dumps(payload).encode()
    req = urllib.request.Request(f"{PROJECT_URL}/rest/v1/rpc/angebotsworkflow_match_wissen", data=body,
        headers={"apikey": ANON, "Authorization": f"Bearer {ANON}", "Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=60))

q = sys.argv[1] if len(sys.argv) > 1 else "Wasserrohr unter Kueche verlegen, Fliesenboden mit Fussbodenheizung aufstemmen"
vec = voyage_query(q)
hits = rpc_match(vec, 6)
print(f'Anfrage: "{q}"\n')
print(f"{len(hits)} Treffer:")
for h in hits:
    print(f"  [{h['aehnlichkeit']:.3f}] ({h['gewerk']}/{h['typ']}) {h['titel']}")
