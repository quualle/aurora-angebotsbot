// =============================================================
// Aurora Angebotsworkflow — Edge Function: angebotsworkflow-embed
// -------------------------------------------------------------
// Admin-/Wartungsfunktion: fuellt fehlende Embeddings (embedding IS NULL)
// in den Katalog-Tabellen via Voyage (voyage-4-large, 1024 Dim).
// Idempotent + wiederholbar. Aufruf nach jedem Katalog-Seed/Update.
//
// Body (optional): { "table": "wissen"|"leistungen"|"material"|"all", "max": 1000 }
// =============================================================
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
let VOYAGE_API_KEY = Deno.env.get("VOYAGE_API_KEY") ?? "";
const EMBED_MODEL = Deno.env.get("EMBED_MODEL") ?? "voyage-4-large";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Voyage-Key aus DB nachladen, falls nicht als Edge-Secret gesetzt.
if (!VOYAGE_API_KEY) {
  try {
    const { data } = await supabase.from("angebotsworkflow_secrets").select("value").eq("key", "secret_voyage_api_key").maybeSingle();
    if (data?.value) VOYAGE_API_KEY = data.value as string;
  } catch (_) { /* handler meldet fehlendes Secret */ }
}

const TABLES: Record<string, { table: string; textCols: string[] }> = {
  wissen:     { table: "angebotsworkflow_wissen",     textCols: ["titel", "inhalt"] },
  leistungen: { table: "angebotsworkflow_leistungen", textCols: ["bezeichnung", "beschreibung", "leistung_code"] },
  material:   { table: "angebotsworkflow_material",   textCols: ["artikel_bezeichnung", "kategorie", "hersteller"] },
};

const BATCH = 64;

async function voyageEmbed(texts: string[], inputType: "document" | "query"): Promise<number[][]> {
  const r = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${VOYAGE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input: texts, model: EMBED_MODEL, input_type: inputType }),
  });
  if (!r.ok) throw new Error(`Voyage ${r.status}: ${(await r.text()).slice(0, 400)}`);
  const data = await r.json();
  return (data.data as Array<{ embedding: number[] }>).map((d) => d.embedding);
}

function buildText(row: Record<string, unknown>, cols: string[]): string {
  return cols.map((c) => (row[c] == null ? "" : String(row[c]))).filter(Boolean).join("\n").slice(0, 8000);
}
function toVectorLiteral(vec: number[]): string {
  return "[" + vec.map((x) => Number(x.toFixed(7))).join(",") + "]";
}

async function embedTable(key: string, max: number): Promise<{ table: string; embedded: number }> {
  const cfg = TABLES[key];
  let embedded = 0;
  while (embedded < max) {
    const { data: rows, error } = await supabase
      .from(cfg.table)
      .select(["id", ...cfg.textCols].join(","))
      .is("embedding", null)
      .limit(BATCH);
    if (error) throw new Error(`select ${cfg.table}: ${error.message}`);
    if (!rows || rows.length === 0) break;

    const texts = rows.map((r) => buildText(r as Record<string, unknown>, cfg.textCols));
    const vectors = await voyageEmbed(texts, "document");

    for (let i = 0; i < rows.length; i++) {
      const id = (rows[i] as { id: number }).id;
      const { error: upErr } = await supabase
        .from(cfg.table)
        .update({ embedding: toVectorLiteral(vectors[i]) })
        .eq("id", id);
      if (upErr) throw new Error(`update ${cfg.table} id=${id}: ${upErr.message}`);
      embedded++;
    }
    if (rows.length < BATCH) break;
  }
  return { table: cfg.table, embedded };
}

Deno.serve(async (req: Request) => {
  try {
    const miss = [["SUPABASE_URL", SUPABASE_URL], ["SUPABASE_SERVICE_ROLE_KEY", SUPABASE_SERVICE_ROLE_KEY], ["VOYAGE_API_KEY", VOYAGE_API_KEY]].filter(([, v]) => !v).map(([k]) => k);
    if (miss.length) return Response.json({ error: `missing secrets: ${miss.join(", ")}` }, { status: 500 });
    let body: { table?: string; max?: number } = {};
    try { body = await req.json(); } catch { /* leerer Body ok */ }
    const target = body.table ?? "all";
    const max = body.max ?? 5000;
    const keys = target === "all" ? Object.keys(TABLES) : [target];
    if (keys.some((k) => !TABLES[k])) {
      return Response.json({ error: `unbekannte Tabelle: ${target}` }, { status: 400 });
    }
    const results = [];
    for (const k of keys) results.push(await embedTable(k, max));
    return Response.json({ ok: true, model: EMBED_MODEL, results });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 500 });
  }
});
