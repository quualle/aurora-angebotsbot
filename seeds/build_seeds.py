#!/usr/bin/env python3
"""Wandelt die JSON-Kataloge der Super-Agenten in INSERT-SQL (ohne Embeddings).
Embeddings werden danach serverseitig via Edge Function angebotsworkflow-embed gefuellt.

Aufruf:
  python3 build_seeds.py wissen     01_wissen.json     01_wissen.sql
  python3 build_seeds.py material   02_material.json   02_material.sql
  python3 build_seeds.py leistungen 03_leistungen.json 03_leistungen.sql
"""
import json, sys

def q(v):
    if v is None: return "NULL"
    if isinstance(v, bool): return "TRUE" if v else "FALSE"
    if isinstance(v, (int, float)): return repr(v)
    if isinstance(v, list):
        if not v: return "ARRAY[]::text[]"
        return "ARRAY[" + ",".join("'" + str(x).replace("'", "''") + "'" for x in v) + "]"
    if isinstance(v, dict):
        return "'" + json.dumps(v, ensure_ascii=False).replace("'", "''") + "'::jsonb"
    return "'" + str(v).replace("'", "''") + "'"

SPECS = {
    "wissen": {
        "table": "angebotsworkflow_wissen",
        "cols": ["gewerk", "typ", "titel", "inhalt", "tags", "metadata"],
        "defaults": {"tags": [], "metadata": {}},
    },
    "leistungen": {
        "table": "angebotsworkflow_leistungen",
        "cols": ["gewerk", "leistung_code", "bezeichnung", "beschreibung", "einheit", "einzelpreis_netto", "kalkulationsbasis", "tags"],
        "defaults": {"tags": []},
    },
    "material": {
        "table": "angebotsworkflow_material",
        "cols": ["kategorie", "artikel_bezeichnung", "hersteller", "lieferant", "artikelnummer", "einheit", "einkaufspreis_netto", "aufschlag_faktor", "listenpreis_netto", "tags"],
        "defaults": {"aufschlag_faktor": 1.10, "listenpreis_netto": None, "tags": []},
    },
}

def main():
    kind, infile, outfile = sys.argv[1], sys.argv[2], sys.argv[3]
    spec = SPECS[kind]
    rows = json.load(open(infile, encoding="utf-8"))
    cols = spec["cols"]
    lines = [f"-- {len(rows)} Zeilen fuer {spec['table']}", f"insert into {spec['table']} ({', '.join(cols)}) values"]
    vals = []
    for r in rows:
        cells = []
        for c in cols:
            v = r.get(c, spec["defaults"].get(c))
            if v is None and c in spec["defaults"]:
                v = spec["defaults"][c]
            cells.append(q(v))
        vals.append("  (" + ", ".join(cells) + ")")
    lines.append(",\n".join(vals) + ";")
    open(outfile, "w", encoding="utf-8").write("\n".join(lines) + "\n")
    print(f"{kind}: {len(rows)} Zeilen -> {outfile}")

if __name__ == "__main__":
    main()
