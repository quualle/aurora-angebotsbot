// =============================================================
// Aurora Angebotsworkflow — Edge Function: angebotsworkflow-telegram
// -------------------------------------------------------------
// Telegram-Angebotsbot fuer Aurora Haustechnik (TGA-Komplettservice).
// Neubau. Alle Tabellen mit Praefix angebotsworkflow_.
//
// Architektur:
//   Telegram (Text/Sprache/Foto/PDF)
//     -> bei Sprache: Transkription via OpenRouter (input_audio)
//     -> GPT-5.5 Agent (OpenRouter) mit eigenem Tool-Loop:
//          wissenskatalog_durchsuchen (RAG, Voyage-Embeddings)
//          leistungspreis_suchen / materialpreis_suchen (Trigram)
//          material_live_recherche (optional, Flag)
//          rueckfrage_stellen (Human-in-the-Loop, pausiert)
//          angebot_erstellen (sevDesk + Storage + DB + Telegram-PDF)
//     -> Korrektur-Loop ueber den vollen Gespraechsverlauf
//
// Ein OpenRouter-Schluessel fuer Chat + Transkription + Vision.
// Voyage nur fuer Embeddings. Webhook antwortet sofort 200,
// Verarbeitung laeuft via EdgeRuntime.waitUntil weiter.
// =============================================================
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ---------- ENV ----------
// Secrets: env-first, sonst aus Tabelle angebotsworkflow_secrets (loadSecretsFromDB beim Kaltstart).
// -> Betrieb ohne Supabase Edge Secrets moeglich; Produktion kann spaeter auf Edge Secrets/Vault umziehen.
let TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
let TELEGRAM_WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";
const TELEGRAM_ALLOWED_USER_IDS_ENV = (Deno.env.get("TELEGRAM_ALLOWED_USER_IDS") ?? "")
  .split(",").map((s) => parseInt(s.trim())).filter((n) => Number.isFinite(n));
let OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY") ?? "";
let VOYAGE_API_KEY = Deno.env.get("VOYAGE_API_KEY") ?? "";
const EMBED_MODEL = Deno.env.get("EMBED_MODEL") ?? "voyage-4-large";
let SEVDESK_API_TOKEN = Deno.env.get("SEVDESK_API_TOKEN") ?? "";
let ADMIN_KEY = Deno.env.get("ADMIN_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// Boot-kritisch (sonst 500 mit klarer Meldung): Webhook-Secret (fail-closed) + KI/Preis-Keys + Supabase.
// TELEGRAM_BOT_TOKEN ist NICHT boot-kritisch -> System bootet token-ready; Antworten scheitern dann nur leise.
function missingEnv(): string[] {
  const req: Record<string, string> = {
    TELEGRAM_WEBHOOK_SECRET, OPENROUTER_API_KEY, VOYAGE_API_KEY, SEVDESK_API_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
  };
  return Object.entries(req).filter(([, v]) => !v).map(([k]) => k);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
let TG = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
let TG_FILE = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}`;
const OR = "https://openrouter.ai/api/v1";
const SEV = "https://my.sevdesk.de/api/v1";
const STORAGE_BUCKET = "angebotsworkflow-angebote";

const MAX_AUDIO_SIZE = 25 * 1024 * 1024;
const MAX_IMAGE_SIZE = 20 * 1024 * 1024;
const MAX_PDF_SIZE = 20 * 1024 * 1024;
const MAX_ITERS = 12;
const GEWERKE = ["heizung", "klima", "lueftung", "sanitaer", "kaelte", "elektro", "gebaeudeautomation", "nebengewerk", "allgemein"];

// Secrets aus DB nachladen (nur was via env fehlt). Laeuft einmal beim Kaltstart (Top-Level-await).
async function loadSecretsFromDB() {
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_WEBHOOK_SECRET && OPENROUTER_API_KEY && VOYAGE_API_KEY && SEVDESK_API_TOKEN && ADMIN_KEY) return;
  try {
    const { data } = await supabase.from("angebotsworkflow_secrets").select("key,value");
    const m: Record<string, string> = {};
    for (const r of (data ?? [])) m[(r as any).key] = (r as any).value;
    TELEGRAM_BOT_TOKEN ||= m["secret_telegram_bot_token"] ?? "";
    TELEGRAM_WEBHOOK_SECRET ||= m["secret_telegram_webhook_secret"] ?? "";
    OPENROUTER_API_KEY ||= m["secret_openrouter_api_key"] ?? "";
    VOYAGE_API_KEY ||= m["secret_voyage_api_key"] ?? "";
    SEVDESK_API_TOKEN ||= m["secret_sevdesk_api_token"] ?? "";
    ADMIN_KEY ||= m["secret_admin_key"] ?? "";
    TG = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
    TG_FILE = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}`;
  } catch (_) { /* missingEnv() meldet fehlende Secrets beim Request */ }
}
await loadSecretsFromDB();

const nowISO = () => new Date().toISOString();
function escapeHtml(s: string) {
  return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------- Config (cached) ----------
let CONFIG_CACHE: { map: Record<string, unknown>; ts: number } | null = null;
async function getConfig(): Promise<Record<string, any>> {
  const now = Date.now();
  if (CONFIG_CACHE && now - CONFIG_CACHE.ts < 60_000) return CONFIG_CACHE.map;
  const map: Record<string, unknown> = {};
  try {
    const { data } = await supabase.from("angebotsworkflow_config").select("key,value");
    for (const r of (data ?? [])) map[(r as any).key] = (r as any).value;
  } catch (_) { /* Defaults unten */ }
  CONFIG_CACHE = { map, ts: now };
  return map;
}

// ---------- Auth (cached) ----------
let ALLOWED_CACHE: { ids: Set<number>; ts: number } | null = null;
async function getAllowedUserIds(): Promise<Set<number>> {
  const now = Date.now();
  if (ALLOWED_CACHE && now - ALLOWED_CACHE.ts < 60_000) return ALLOWED_CACHE.ids;
  const ids = new Set<number>(TELEGRAM_ALLOWED_USER_IDS_ENV);
  try {
    const { data } = await supabase.from("angebotsworkflow_allowed_users").select("telegram_user_id");
    for (const r of (data ?? [])) {
      const v = (r as any).telegram_user_id;
      const n = typeof v === "number" ? v : parseInt(v);
      if (Number.isFinite(n)) ids.add(n);
    }
  } catch (_) { /* Env-Fallback */ }
  ALLOWED_CACHE = { ids, ts: now };
  return ids;
}

// ---------- Telegram ----------
async function tgSendRaw(chat_id: number, text: string, extra: Record<string, unknown> = {}) {
  return await fetch(`${TG}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra }),
  }).then((r) => r.json()).catch(() => null);
}
async function tgSend(chat_id: number, text: string, extra: Record<string, unknown> = {}) {
  const LIMIT = 3900;
  if (text.length <= LIMIT) return await tgSendRaw(chat_id, text, extra);
  const chunks: string[] = []; let cur = "";
  for (const ln of text.split("\n")) {
    if (cur && (cur.length + 1 + ln.length) > LIMIT) { chunks.push(cur); cur = ln; }
    else cur = cur ? cur + "\n" + ln : ln;
  }
  if (cur) chunks.push(cur);
  let res = null;
  for (let i = 0; i < chunks.length; i++) res = await tgSendRaw(chat_id, chunks[i], i === chunks.length - 1 ? extra : {});
  return res;
}
async function tgAnswerCb(callback_query_id: string, text?: string) {
  return await fetch(`${TG}/answerCallbackQuery`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id, text }),
  }).then((r) => r.json()).catch(() => null);
}
async function tgSendDocument(chat_id: number, filename: string, bytes: Uint8Array, caption?: string) {
  const fd = new FormData();
  fd.append("chat_id", String(chat_id));
  fd.append("document", new Blob([bytes], { type: "application/pdf" }), filename);
  if (caption) { fd.append("caption", caption); fd.append("parse_mode", "HTML"); }
  const r = await fetch(`${TG}/sendDocument`, { method: "POST", body: fd });
  if (!r.ok) throw new Error(`Telegram sendDocument ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
async function tgGetFile(file_id: string): Promise<{ file_path: string }> {
  const r = await fetch(`${TG}/getFile?file_id=${encodeURIComponent(file_id)}`);
  const data = await r.json();
  if (!data.ok) throw new Error(`Telegram getFile: ${JSON.stringify(data).slice(0, 200)}`);
  return { file_path: data.result.file_path };
}
async function tgDownloadFile(file_path: string): Promise<{ bytes: Uint8Array; mime: string; filename: string }> {
  const r = await fetch(`${TG_FILE}/${file_path}`);
  if (!r.ok) throw new Error(`Telegram download ${r.status}`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  return { bytes, mime: r.headers.get("Content-Type") ?? "application/octet-stream", filename: file_path.split("/").pop() ?? "file" };
}
function bytesToBase64(bytes: Uint8Array): string {
  let bin = ""; const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk) as unknown as number[]);
  return btoa(bin);
}

// ---------- OpenRouter ----------
async function orChat(model: string, messages: any[], opts: { tools?: any[]; tool_choice?: string } = {}): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 120_000);
  try {
    const r = await fetch(`${OR}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json",
        "HTTP-Referer": "https://aurora-engineering.de", "X-Title": "Aurora Angebotsbot",
      },
      body: JSON.stringify({ model, messages, ...(opts.tools ? { tools: opts.tools, tool_choice: opts.tool_choice ?? "auto" } : {}) }),
      signal: ctrl.signal,
    });
    const data = await r.json();
    if (!r.ok) throw new Error(`OpenRouter ${r.status}: ${JSON.stringify(data).slice(0, 400)}`);
    return data;
  } finally { clearTimeout(t); }
}

// Telegram-Voice ist OGG/Opus (Endung .oga). OpenRouter/Gemini akzeptiert "ogg" (im Test verifiziert).
function normAudioFmt(filename: string): string {
  const ext = (filename.split(".").pop() || "ogg").toLowerCase();
  const map: Record<string, string> = { oga: "ogg", ogg: "ogg", opus: "ogg", mpga: "mp3", mp3: "mp3", m4a: "m4a", mp4: "m4a", aac: "m4a", wav: "wav", flac: "flac" };
  return map[ext] ?? "ogg";
}
async function transcribeAudio(bytes: Uint8Array, format: string, model: string): Promise<string> {
  const b64 = bytesToBase64(bytes);
  const data = await orChat(model, [{
    role: "user",
    content: [
      { type: "text", text: "Transkribiere diese Sprachnachricht woertlich auf Deutsch. Gib NUR den transkribierten Text zurueck, ohne Kommentar. Wenn nichts Verstaendliches gesprochen wird, antworte exakt mit LEER." },
      { type: "input_audio", input_audio: { data: b64, format } },
    ],
  }]);
  const txt = (data.choices?.[0]?.message?.content ?? "").trim();
  return txt === "LEER" ? "" : txt;
}

async function describeImage(bytes: Uint8Array, mime: string, model: string): Promise<string> {
  const dataUrl = `data:${mime};base64,${bytesToBase64(bytes)}`;
  const data = await orChat(model, [
    { role: "system", content: "Du bist TGA-/HKLS-Experte. Beschreibe das Foto kurz und sachlich (3-6 Saetze) mit Fokus auf angebotsrelevante Details (Geraete, Typenschilder, Masse, Zustand, Material). Keine Mutmassungen." },
    { role: "user", content: [
      { type: "text", text: "Aurora Haustechnik bekommt das vom Kunden fuer ein Angebot. Was ist hier zu sehen?" },
      { type: "image_url", image_url: { url: dataUrl } },
    ] },
  ]);
  return (data.choices?.[0]?.message?.content ?? "").trim();
}

async function extractPdfText(bytes: Uint8Array, filename: string, model: string): Promise<string> {
  // OpenRouter file-parser plugin (pdf-text). Ein Schluessel, kein separater OCR-Dienst.
  const b64 = bytesToBase64(bytes);
  const r = await fetch(`${OR}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      plugins: [{ id: "file-parser", pdf: { engine: "pdf-text" } }],
      messages: [{ role: "user", content: [
        { type: "text", text: "Gib den vollstaendigen Textinhalt dieses PDF strukturiert wieder (Positionen, Mengen, Texte). Kein Kommentar." },
        { type: "file", file: { filename, file_data: `data:application/pdf;base64,${b64}` } },
      ] }],
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`PDF-Parsing ${r.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return (data.choices?.[0]?.message?.content ?? "").trim();
}

// ---------- Voyage (Query-Embedding) ----------
async function voyageQuery(text: string): Promise<string> {
  const r = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${VOYAGE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input: [text], model: EMBED_MODEL, input_type: "query" }),
  });
  if (!r.ok) throw new Error(`Voyage ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  const vec: number[] = data.data[0].embedding;
  return "[" + vec.map((x) => Number(x.toFixed(7))).join(",") + "]";
}

// ---------- sevDesk (erprobte Sequenz) ----------
async function sev(method: string, path: string, body?: unknown) {
  const res = await fetch(`${SEV}${path}`, {
    method,
    headers: { Authorization: SEVDESK_API_TOKEN, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text();
  let data: any = null;
  try { data = txt ? JSON.parse(txt) : null; } catch { /* ignore */ }
  if (!res.ok) throw new Error(`sevdesk ${method} ${path} -> ${res.status}: ${txt.slice(0, 300)}`);
  return data;
}
function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
async function getOrderPdf(orderId: number): Promise<{ filename: string; bytes: Uint8Array }> {
  const data = await sev("GET", `/Order/${orderId}/getPdf`);
  let obj = data?.objects ?? data;
  if (Array.isArray(obj)) obj = obj[0];
  const content: string | undefined = obj?.content;
  if (!content) throw new Error("sevdesk getPdf: kein content");
  const filename = (typeof obj?.filename === "string" && obj.filename) ? obj.filename : `Angebot_${orderId}.pdf`;
  return { filename, bytes: base64ToBytes(content) };
}
async function getNextOrderNumber(): Promise<string> {
  try {
    const r = await sev("GET", "/SevSequence/Factory/getByType?objectType=Order&type=AN");
    const next = r?.objects?.nextSequence ?? r?.objects?.value ?? r?.objects;
    if (typeof next === "string" && next.length > 0) return next;
  } catch (_) { /* fallback */ }
  const d = new Date(); const p = (n: number) => String(n).padStart(2, "0");
  return `AN-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}
let UNITY_CACHE: Map<string, number> | null = null;
async function getUnityMap(): Promise<Map<string, number>> {
  if (UNITY_CACHE) return UNITY_CACHE;
  const data = await sev("GET", "/Unity?limit=100");
  const map = new Map<string, number>();
  for (const u of (data?.objects ?? [])) {
    const id = parseInt(u.id); if (Number.isNaN(id)) continue;
    for (const key of [u.unitCode, u.translationCode, u.name]) if (typeof key === "string" && key) map.set(key.toLowerCase().trim(), id);
  }
  UNITY_CACHE = map;
  return map;
}
function resolveUnityId(unit: string, map: Map<string, number>): number {
  const u = (unit || "").toLowerCase().trim();
  if (map.has(u)) return map.get(u)!;
  const aliases: Record<string, string[]> = {
    "stk": ["stk", "st", "stueck", "stück", "piece", "unity_piece", "pcs"],
    "stück": ["stk", "stueck", "stück", "piece", "unity_piece"],
    "h": ["h", "std", "stunde", "hour", "unity_hour"], "std": ["h", "std", "stunde", "hour"], "stunde": ["h", "std", "stunde", "hour"],
    "m": ["m", "meter", "unity_meter"],
    "m²": ["m²", "m2", "qm", "quadratmeter", "unity_square_meter"], "m2": ["m²", "m2", "qm", "quadratmeter"], "qm": ["m²", "m2", "qm"],
    "m³": ["m³", "m3", "kubikmeter", "unity_cubic_meter"], "m3": ["m³", "m3", "kubikmeter"],
    "kg": ["kg", "kilogramm"], "l": ["l", "liter", "unity_litre", "unity_liter"], "set": ["set", "satz", "stk"], "rolle": ["rolle", "stk"],
    "psch": ["pauschal", "psch", "pa", "pauschalbetrag", "lump_sum", "unity_lump_sum", "flat_rate"],
    "pauschal": ["pauschal", "psch", "pa", "lump_sum", "unity_lump_sum"],
  };
  for (const t of (aliases[u] ?? [u])) if (map.has(t)) return map.get(t)!;
  const first = map.values().next().value as number | undefined;
  if (typeof first === "number") return first;
  throw new Error(`Keine Unity-ID fuer "${unit}"`);
}
async function getSevUserId(): Promise<number> {
  const me = await sev("GET", "/SevUser");
  return parseInt(me.objects[0].id);
}
// CommunicationWayKey-ID dynamisch aus dem Account holen (Account-spezifisch; NICHT hartkodieren).
let COMMKEY_CACHE: number | null = null;
async function getCommWayKeyId(): Promise<number> {
  if (COMMKEY_CACHE !== null) return COMMKEY_CACHE;
  try {
    const data = await sev("GET", "/CommunicationWayKey");
    const keys = (data?.objects ?? []) as any[];
    const pick = keys.find((x) => x.translationCode === "COMM_WAY_KEY_PRIVAT")
      ?? keys.find((x) => x.translationCode === "COMM_WAY_KEY_WORK")
      ?? keys.find((x) => parseInt(x.id) > 0);
    COMMKEY_CACHE = pick ? parseInt(pick.id) : 1;
  } catch (_) { COMMKEY_CACHE = 1; }
  return COMMKEY_CACHE;
}
async function findOrCreateSevContact(k: any): Promise<{ id: number; nr: string }> {
  const q = encodeURIComponent(k.firma || `${k.vorname ?? ""} ${k.name}`.trim());
  try {
    const search = await sev("GET", `/Contact?depth=1&name=${q}`);
    const hit = (search?.objects ?? [])[0];
    if (hit) return { id: parseInt(hit.id), nr: hit.customerNumber };
  } catch (_) { /* weiter */ }
  const isCompany = !!k.ist_firma || !!k.firma;
  const contact = await sev("POST", "/Contact", {
    objectName: "Contact",
    name: k.firma || `${k.vorname ? k.vorname + " " : ""}${k.name}`,
    surename: !isCompany ? k.vorname : undefined,
    familyname: !isCompany ? k.name : undefined,
    category: { id: isCompany ? 3 : 4, objectName: "Category" },
  });
  const id = parseInt(contact.objects.id);
  // Adresse/Telefon/E-Mail sind Anreicherung -> NIE fatal (Adresse steht ohnehin im Order).
  const commKey = await getCommWayKeyId();
  if (k.strasse || k.plz || k.ort) {
    try {
      await sev("POST", "/ContactAddress", {
        objectName: "ContactAddress", contact: { id, objectName: "Contact" },
        street: k.strasse, zip: k.plz, city: k.ort, country: { id: 1, objectName: "StaticCountry" },
      });
    } catch (_) { /* non-fatal */ }
  }
  try { if (k.telefon) await sev("POST", "/CommunicationWay", { objectName: "CommunicationWay", contact: { id, objectName: "Contact" }, type: "PHONE", value: k.telefon, key: { id: commKey, objectName: "CommunicationWayKey" }, main: true }); } catch (_) { /* non-fatal */ }
  try { if (k.email) await sev("POST", "/CommunicationWay", { objectName: "CommunicationWay", contact: { id, objectName: "Contact" }, type: "EMAIL", value: k.email, key: { id: commKey, objectName: "CommunicationWayKey" }, main: true }); } catch (_) { /* non-fatal */ }
  return { id, nr: contact.objects.customerNumber };
}
async function createSevOrder(opts: { contactId: number; sevUserId: number; bezeichnung: string; positionen: any[]; kunde: any }): Promise<{ id: number; nr: string }> {
  const orderNumber = await getNextOrderNumber();
  const unityMap = await getUnityMap();
  const payload = {
    objectName: "Order", orderNumber,
    contact: { id: opts.contactId, objectName: "Contact" },
    contactPerson: { id: opts.sevUserId, objectName: "SevUser" },
    orderDate: new Date().toISOString().slice(0, 10), status: 100, header: opts.bezeichnung,
    headText: "Sehr geehrte Damen und Herren,<br><br>vielen Dank fuer Ihre Anfrage. Gerne unterbreiten wir Ihnen folgendes Angebot:",
    footText: "Es gelten unsere Allgemeinen Geschaeftsbedingungen. Angebot gueltig 30 Tage.",
    addressName: opts.kunde.firma || `${opts.kunde.vorname ? opts.kunde.vorname + " " : ""}${opts.kunde.name}`,
    addressStreet: opts.kunde.strasse ?? "", addressZip: opts.kunde.plz ?? "", addressCity: opts.kunde.ort ?? "",
    addressCountry: { id: 1, objectName: "StaticCountry" },
    paymentTerms: "Zahlbar innerhalb 14 Tagen ohne Abzug nach Rechnungserhalt.",
    orderType: "AN", sendType: "VPR", currency: "EUR", taxRate: 19, taxText: "Umsatzsteuer 19%", taxType: "default",
    smallSettlement: false, version: 0, discount: 0, showNet: true,
  };
  const order = await sev("POST", "/Order", payload);
  const id = parseInt(order.objects.id);
  try {
    let posIdx = 1;
    for (const p of opts.positionen) {
      await sev("POST", "/OrderPos", {
        objectName: "OrderPos", order: { id, objectName: "Order" },
        quantity: p.menge, price: p.einzelpreis_netto, name: p.bezeichnung, text: p.beschreibung || "",
        unity: { id: resolveUnityId(p.einheit, unityMap), objectName: "Unity" }, taxRate: 19, positionNumber: posIdx++,
      });
    }
  } catch (posErr) {
    try { await sev("DELETE", `/Order/${id}`); } catch (_) { /* best effort */ }
    throw posErr;
  }
  return { id, nr: order.objects.orderNumber };
}
async function deleteSevOrder(orderId: number) { try { await sev("DELETE", `/Order/${orderId}`); } catch (_) { /* best effort */ } }

// ---------- DB-Helfer ----------
async function audit(chat_id: number | null, user_id: number | null, event_type: string, payload: unknown) {
  try { await supabase.from("angebotsworkflow_audit_log").insert({ telegram_chat_id: chat_id, telegram_user_id: user_id, event_type, payload }); } catch (_) { /* non-fatal */ }
}
async function getSession(chat_id: number, user_id: number) {
  const { data } = await supabase.from("angebotsworkflow_sessions").select("*").eq("telegram_chat_id", chat_id).maybeSingle();
  if (data) return data;
  const { data: created } = await supabase.from("angebotsworkflow_sessions")
    .insert({ telegram_chat_id: chat_id, telegram_user_id: user_id, current_state: { messages: [] } }).select("*").single();
  return created;
}
async function saveState(chat_id: number, current_state: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  await supabase.from("angebotsworkflow_sessions")
    .update({ current_state, last_activity_at: nowISO(), ...extra }).eq("telegram_chat_id", chat_id);
}
async function clearSession(chat_id: number) {
  await supabase.from("angebotsworkflow_sessions")
    .update({ current_state: { messages: [] }, draft_angebot_id: null, vorgang_id: null, last_activity_at: nowISO() })
    .eq("telegram_chat_id", chat_id);
}
type Vorgang = { id: string; roh_eingaben: any[]; wissens_treffer: any[]; hitl_verlauf: any[]; kalkulation: any; angebot_id: string | null; pdf_storage_path: string | null; status: string };
async function ensureVorgang(state: any, chat_id: number, user_id: number): Promise<Vorgang> {
  if (state.vorgang_id) {
    const { data } = await supabase.from("angebotsworkflow_vorgaenge").select("*").eq("id", state.vorgang_id).maybeSingle();
    if (data) return data as Vorgang;
  }
  const { data: created } = await supabase.from("angebotsworkflow_vorgaenge")
    .insert({ telegram_chat_id: chat_id, telegram_user_id: user_id, status: "offen" }).select("*").single();
  state.vorgang_id = (created as any).id;
  return created as Vorgang;
}
async function saveVorgang(v: Vorgang) {
  await supabase.from("angebotsworkflow_vorgaenge").update({
    roh_eingaben: v.roh_eingaben, wissens_treffer: v.wissens_treffer, hitl_verlauf: v.hitl_verlauf,
    kalkulation: v.kalkulation, angebot_id: v.angebot_id, pdf_storage_path: v.pdf_storage_path,
    status: v.status, updated_at: nowISO(),
  }).eq("id", v.id);
}

// ---------- System-Prompt ----------
function buildSystemPrompt(cfg: Record<string, any>): string {
  const s = cfg.stundensaetze_netto ?? { helfer: 58, monteur: 72, meister: 95 };
  const anfahrt = cfg.anfahrtspauschale_netto ?? 45;
  const agk = cfg.agk_prozent ?? 8, wg = cfg.wg_prozent ?? 10, mwst = cfg.mwst_prozent ?? 19;
  return `Du bist der Angebots-Assistent von Aurora Haustechnik (TGA-Komplettservice: Heizung, Klima, Lueftung, Sanitaer, Kaelte, Elektro, Gebaeudeautomation; dazu Nebengewerke wie Boden/Fliesen, Estrich, Durchbrueche, Trockenbau, Maler).

Ein Monteur steht beim Kunden vor Ort und beschreibt dir per Text oder Sprache ein Vorhaben. Ziel: in wenigen Minuten ein belastbares Angebot erzeugen.

ARBEITSWEISE — nutze deine Werkzeuge selbststaendig, in sinnvoller Reihenfolge, so oft wie noetig:
1. Verstehe das Anliegen. Rufe wissenskatalog_durchsuchen auf, um Regeln, Pflichtfragen, Sonderfaelle und Normen zu finden.
2. Pruefe Vollstaendigkeit. Fehlen entscheidungsrelevante Angaben, buendle sie und stelle sie mit rueckfrage_stellen (mehrere Fragen auf einmal). Frage NUR, was du wirklich brauchst.
   ADAPTIV bei Luecken: Kleine/guenstige/unkritische Unklarheiten -> marktuebliche Annahme treffen, Position mit is_assumption=true markieren und in ai_annahmen nennen. Grosse/teure/sicherheitsrelevante Luecken (Geraeteleistung, Erzeuger-Typ, fehlende Masse, Brandschutz, Statik) -> per Rueckfrage klaeren.
3. Unterscheide Dienstleistung vs. Material.
4. Hole Dienstleistungspreise mit leistungspreis_suchen und Materialpreise mit materialpreis_suchen (nutze verkaufspreis_netto). Nichts gefunden und unkritisch -> schaetzen + als Annahme markieren.
5. Baue die Positionen NETTO. Typisch 8-15: Demontage, Material einzeln, Lohn je Taetigkeit, Nebengewerke, Anfahrt. Setze je Position eine kategorie (material/lohn/demontage/anfahrt/nebengewerk/sonstiges).
6. Erstelle das Angebot mit angebot_erstellen. Danach kann der Monteur Korrekturen schicken -> dann angebot_erstellen erneut mit basis_angebot_id (neue Version).

KALKULATIONSSTANDARDS (netto): Stundensaetze Helfer ${s.helfer} EUR/h, Monteur ${s.monteur} EUR/h, Meister ${s.meister} EUR/h. Anfahrtspauschale ${anfahrt} EUR. AGK ${agk}% + Wagnis&Gewinn ${wg}% sind in den Katalogpreisen eingerechnet. MwSt ${mwst}% kommt separat in sevDesk — du kalkulierst NETTO.

KUNDE: Fuer ein Angebot brauchst du mindestens Kundenname und Anschrift (Strasse, PLZ, Ort). Fehlt das, frag danach (gebuendelt mit den fachlichen Fragen).

STIL: Deutsch, echte Umlaute. Praezise, knappe Rueckfragen. Erfinde keine Fakten. Transkripte koennen Fehler enthalten — korrigiere Offensichtliches still. gewerk-Codes: ${GEWERKE.join(", ")}.`;
}

// ---------- Tools ----------
const POSITION_SCHEMA = {
  type: "object",
  properties: {
    bezeichnung: { type: "string" }, beschreibung: { type: "string" },
    menge: { type: "number" }, einheit: { type: "string", description: "Stk, m, m², m³, h, kg, l, Psch" },
    einzelpreis_netto: { type: "number" },
    kategorie: { type: "string", enum: ["material", "lohn", "demontage", "anfahrt", "nebengewerk", "sonstiges"] },
    is_assumption: { type: "boolean", description: "true wenn Menge/Preis geschaetzt" },
    quelle: { type: "string", description: "z.B. leistung:SAN-014 oder material:42 oder annahme" },
  },
  required: ["bezeichnung", "menge", "einheit", "einzelpreis_netto", "kategorie"],
};
const KUNDE_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" }, vorname: { type: "string" }, firma: { type: "string" }, ist_firma: { type: "boolean" },
    strasse: { type: "string" }, plz: { type: "string" }, ort: { type: "string" }, telefon: { type: "string" }, email: { type: "string" },
  },
  required: ["name", "strasse", "plz", "ort"],
};
const TOOLS = [
  { type: "function", function: { name: "wissenskatalog_durchsuchen", description: "Durchsucht den Wissenskatalog (Wenn-Dann-Regeln, Pflichtfragen, How-to, Normen) semantisch.", parameters: { type: "object", properties: { query: { type: "string" }, gewerk: { type: "string", enum: GEWERKE } }, required: ["query"] } } },
  { type: "function", function: { name: "leistungspreis_suchen", description: "Sucht Dienstleistungspositionen + Preise im Leistungskatalog von Aurora.", parameters: { type: "object", properties: { beschreibung: { type: "string" }, gewerk: { type: "string", enum: GEWERKE } }, required: ["beschreibung"] } } },
  { type: "function", function: { name: "materialpreis_suchen", description: "Sucht Materialpositionen + Preise (verkaufspreis_netto) im Materialkatalog.", parameters: { type: "object", properties: { artikel: { type: "string" }, kategorie: { type: "string" } }, required: ["artikel"] } } },
  { type: "function", function: { name: "material_live_recherche", description: "Optionale Live-Webrecherche fuer Materialpreise (nur falls aktiviert).", parameters: { type: "object", properties: { artikel: { type: "string" } }, required: ["artikel"] } } },
  { type: "function", function: { name: "rueckfrage_stellen", description: "Stellt dem Monteur eine oder mehrere gebuendelte Rueckfragen. Pausiert bis zur Antwort.", parameters: { type: "object", properties: { fragen: { type: "array", items: { type: "string" }, minItems: 1 } }, required: ["fragen"] } } },
  { type: "function", function: { name: "angebot_erstellen", description: "Erstellt das Angebot in sevDesk, legt das PDF ab und schickt es. Fuer Korrekturen basis_angebot_id setzen (neue Version).", parameters: { type: "object", properties: { kunde: KUNDE_SCHEMA, gewerk: { type: "string", enum: ["heizung", "klima", "lueftung", "sanitaer", "kaelte", "elektro", "gebaeudeautomation", "mehrere", "sonstiges"] }, bezeichnung: { type: "string" }, positionen: { type: "array", minItems: 1, items: POSITION_SCHEMA }, ai_zusammenfassung: { type: "string" }, ai_annahmen: { type: "array", items: { type: "string" } }, ziel_rahmen_min: { type: "number" }, ziel_rahmen_max: { type: "number" }, basis_angebot_id: { type: "string", description: "UUID des Vor-Angebots bei Korrektur" } }, required: ["kunde", "gewerk", "bezeichnung", "positionen", "ai_zusammenfassung"] } } },
];

const normGewerk = (g?: string) => (g && GEWERKE.includes(g) ? g : null);
function buildTools(cfg: Record<string, any>) {
  return cfg.material_live_recherche_enabled === true
    ? TOOLS
    : TOOLS.filter((t) => t.function.name !== "material_live_recherche");
}

async function executeTool(tc: any, ctx: { chat_id: number; user_id: number; vorgang: Vorgang; cfg: Record<string, any> }): Promise<{ payload: unknown; pause?: boolean; terminal?: boolean }> {
  const name = tc.function?.name;
  let args: any = {};
  try { args = JSON.parse(tc.function?.arguments ?? "{}"); } catch { /* ignore */ }
  await audit(ctx.chat_id, ctx.user_id, `tool:${name}`, { args });
  try {
    if (name === "wissenskatalog_durchsuchen") {
      const vec = await voyageQuery(args.query);
      const { data } = await supabase.rpc("angebotsworkflow_match_wissen", { query_embedding: vec, match_count: 6, filter_gewerk: normGewerk(args.gewerk) });
      const hits = (data ?? []).map((h: any) => ({ titel: h.titel, typ: h.typ, gewerk: h.gewerk, inhalt: h.inhalt, aehnlichkeit: Number(h.aehnlichkeit?.toFixed?.(3) ?? h.aehnlichkeit) }));
      ctx.vorgang.wissens_treffer.push({ query: args.query, treffer: hits.map((h: any) => h.titel) });
      return { payload: { treffer: hits } };
    }
    if (name === "leistungspreis_suchen") {
      const { data } = await supabase.rpc("angebotsworkflow_search_leistungen", { q: args.beschreibung, match_count: 8, filter_gewerk: normGewerk(args.gewerk) });
      return { payload: { treffer: data ?? [] } };
    }
    if (name === "materialpreis_suchen") {
      const { data } = await supabase.rpc("angebotsworkflow_search_material", { q: args.artikel, match_count: 8, filter_kategorie: args.kategorie ?? null });
      return { payload: { treffer: data ?? [] } };
    }
    if (name === "material_live_recherche") {
      const enabled = ctx.cfg.material_live_recherche_enabled === true;
      if (!enabled) return { payload: { disabled: true, hinweis: "Live-Recherche deaktiviert. Bitte marktueblich schaetzen und Position als Annahme (is_assumption=true) markieren oder gezielt nachfragen." } };
      return { payload: { disabled: false, ergebnis: [], hinweis: "Live-Recherche aktiviert, aber in dieser Version noch nicht angebunden. Bitte schaetzen + markieren." } };
    }
    if (name === "rueckfrage_stellen") {
      const fragen: string[] = Array.isArray(args.fragen) ? args.fragen.filter(Boolean) : [String(args.fragen ?? "")].filter(Boolean);
      const txt = fragen.length > 1
        ? "❓ <b>Ein paar Rueckfragen:</b>\n" + fragen.map((f, i) => `${i + 1}. ${escapeHtml(f)}`).join("\n")
        : "❓ " + escapeHtml(fragen[0] ?? "Bitte etwas mehr Details.");
      await tgSend(ctx.chat_id, txt);
      ctx.vorgang.hitl_verlauf.push({ ts: nowISO(), fragen });
      ctx.vorgang.status = "rueckfrage";
      return { payload: { status: "fragen_gesendet", anzahl: fragen.length }, pause: true };
    }
    if (name === "angebot_erstellen") {
      return await toolAngebotErstellen(args, ctx);
    }
    return { payload: { error: `unbekanntes Tool ${name}` } };
  } catch (e) {
    await audit(ctx.chat_id, ctx.user_id, "error", { stage: `tool:${name}`, error: String(e) });
    return { payload: { error: String(e).slice(0, 300) } };
  }
}

async function toolAngebotErstellen(a: any, ctx: { chat_id: number; user_id: number; vorgang: Vorgang }): Promise<{ payload: unknown; terminal?: boolean }> {
  const chat_id = ctx.chat_id;
  // Pflichtfelder hart pruefen, bevor in sevDesk etwas angelegt wird
  const k = a.kunde ?? {};
  const fehlend = ["name", "strasse", "plz", "ort"].filter((f) => !k[f] || String(k[f]).trim() === "");
  if (fehlend.length) return { payload: { error: "Kundendaten unvollstaendig", fehlende_felder: fehlend, hinweis: "Bitte diese Angaben mit rueckfrage_stellen erfragen, dann angebot_erstellen erneut aufrufen." } };
  if (!Array.isArray(a.positionen) || a.positionen.length === 0) return { payload: { error: "keine Positionen vorhanden" } };
  // Korrektur?
  let parent: any = null;
  if (a.basis_angebot_id) {
    const { data } = await supabase.from("angebotsworkflow_angebote").select("*").eq("id", a.basis_angebot_id).maybeSingle();
    parent = data ?? null;
  }
  const version = parent ? (parent.version ?? 1) + 1 : 1;
  await tgSend(chat_id, parent ? "✏️ Erstelle neue Version in sevDesk…" : "📋 Erstelle Angebot in sevDesk…");

  const sevContact = await findOrCreateSevContact(a.kunde);
  const { data: kunde } = await supabase.from("angebotsworkflow_kunden").upsert({
    sevdesk_contact_id: sevContact.id, name: a.kunde.name, vorname: a.kunde.vorname, firma: a.kunde.firma,
    anschrift_strasse: a.kunde.strasse, anschrift_plz: a.kunde.plz, anschrift_ort: a.kunde.ort, telefon: a.kunde.telefon, email: a.kunde.email,
  }, { onConflict: "sevdesk_contact_id" }).select("*").single();

  const sevUserId = await getSevUserId();
  const sevOrder = await createSevOrder({ contactId: sevContact.id, sevUserId, bezeichnung: a.bezeichnung, positionen: a.positionen, kunde: a.kunde });
  const summe = a.positionen.reduce((acc: number, p: any) => acc + Number(p.menge) * Number(p.einzelpreis_netto), 0);

  const { data: angebot } = await supabase.from("angebotsworkflow_angebote").insert({
    sevdesk_order_id: sevOrder.id, sevdesk_order_nr: sevOrder.nr, kunde_id: kunde!.id, vorgang_id: ctx.vorgang.id,
    gewerk: a.gewerk, bezeichnung: a.bezeichnung, telegram_chat_id: chat_id, status: "draft", summe_netto: summe,
    ziel_rahmen_min: a.ziel_rahmen_min, ziel_rahmen_max: a.ziel_rahmen_max,
    ai_zusammenfassung: a.ai_zusammenfassung, ai_annahmen: a.ai_annahmen ?? [], version,
    parent_angebot_id: parent ? parent.id : null,
  }).select("*").single();

  const positions = a.positionen.map((p: any, i: number) => ({
    angebot_id: angebot!.id, position_nr: i + 1, bezeichnung: p.bezeichnung, beschreibung: p.beschreibung,
    menge: p.menge, einheit: p.einheit, einzelpreis_netto: p.einzelpreis_netto,
    gesamt_netto: Number(p.menge) * Number(p.einzelpreis_netto), kategorie: p.kategorie ?? null,
    is_assumption: p.is_assumption ?? false, quelle: p.quelle ?? null,
  }));
  await supabase.from("angebotsworkflow_angebote_positionen").insert(positions);

  // Ab hier ist das Angebot in sevDesk + DB angelegt -> alles Weitere best-effort,
  // niemals als Tool-Fehler zuruecksignalisieren (sonst riskiert das Modell eine Doppel-Anlage).
  try {
  if (parent) {
    await supabase.from("angebotsworkflow_angebote").update({ status: "geaendert" }).eq("id", parent.id);
    if (parent.sevdesk_order_id) await deleteSevOrder(parent.sevdesk_order_id);
  }

  // PDF holen + in Storage ablegen
  let pdfPath: string | null = null;
  try {
    const pdf = await getOrderPdf(sevOrder.id);
    pdfPath = `${chat_id}/${sevOrder.nr}_v${version}.pdf`;
    await supabase.storage.from(STORAGE_BUCKET).upload(pdfPath, pdf.bytes, { contentType: "application/pdf", upsert: true });
    await supabase.from("angebotsworkflow_angebote").update({ pdf_storage_path: pdfPath }).eq("id", angebot!.id);
    const caption = `${parent ? "✏️" : "📄"} Angebot <b>${escapeHtml(sevOrder.nr)}</b>${parent ? ` (V${version})` : ""} — ${escapeHtml(a.bezeichnung)}\nSumme netto: <b>${summe.toFixed(2)} €</b> (zzgl. 19% MwSt)`;
    await tgSendDocument(chat_id, pdf.filename, pdf.bytes, caption);
  } catch (e) {
    await audit(chat_id, ctx.user_id, "error", { stage: "pdf", error: String(e) });
    await tgSend(chat_id, `⚠️ PDF konnte nicht erzeugt/abgelegt werden: <code>${escapeHtml(String(e)).slice(0, 200)}</code>`);
  }

  // Zusammenfassung + Buttons
  const annahmen = (a.ai_annahmen ?? []).map((x: string) => `• ${escapeHtml(x)}`).join("\n");
  const posList = a.positionen.map((p: any, i: number) => {
    const flag = p.is_assumption ? " ⚠️" : "";
    const total = (Number(p.menge) * Number(p.einzelpreis_netto)).toFixed(2);
    return `${i + 1}. ${escapeHtml(p.bezeichnung)}${flag}\n   ${p.menge} ${escapeHtml(p.einheit)} × ${Number(p.einzelpreis_netto).toFixed(2)} € = <b>${total} €</b>`;
  }).join("\n");
  const txt =
    `${parent ? `✏️ <b>Neue Version V${version} erstellt</b>` : "✅ <b>Angebot erstellt + PDF gesendet</b>"}\n` +
    `Kunde: ${escapeHtml(a.kunde.firma || `${a.kunde.vorname ?? ""} ${a.kunde.name}`.trim())}\n` +
    `sevDesk-Nr: <code>${escapeHtml(sevOrder.nr)}</code>\n\n<b>Positionen:</b>\n${posList}\n\n<b>Summe netto: ${summe.toFixed(2)} €</b>\n\n` +
    `<b>Zusammenfassung:</b>\n${escapeHtml(a.ai_zusammenfassung)}` +
    (annahmen ? `\n\n<b>⚠️ Annahmen:</b>\n${annahmen}` : "") +
    `\n\n<i>Korrektur? Einfach schreiben/sprechen. Neues Angebot: /neu</i>`;
  await tgSend(chat_id, txt, {
    reply_markup: { inline_keyboard: [[
      { text: "✅ Freigeben", callback_data: `approve:${angebot!.id}` },
      { text: "✏️ Anpassen", callback_data: `edit:${angebot!.id}` },
      { text: "❌ Verwerfen", callback_data: `reject:${angebot!.id}` },
    ]] },
  });

  ctx.vorgang.kalkulation = { summe_netto: summe, positionen: a.positionen, annahmen: a.ai_annahmen ?? [] };
  ctx.vorgang.angebot_id = angebot!.id;
  ctx.vorgang.pdf_storage_path = pdfPath;
  ctx.vorgang.status = "angebot_erstellt";
  await audit(chat_id, ctx.user_id, "angebot_erstellt", { angebot_id: angebot!.id, sevdesk_order_id: sevOrder.id, version, summe });
  await supabase.from("angebotsworkflow_sessions").update({ draft_angebot_id: angebot!.id }).eq("telegram_chat_id", chat_id);
  } catch (e) {
    await audit(chat_id, ctx.user_id, "error", { stage: "angebot_nachbereitung_nonfatal", error: String(e) });
  }
  return { payload: { status: "angebot_erstellt", angebot_id: angebot!.id, sevdesk_order_nr: sevOrder.nr, version, summe_netto: summe, hinweis: "Fuer Korrekturen erneut angebot_erstellen mit basis_angebot_id=" + angebot!.id }, terminal: true };
}

// ---------- Agent-Loop ----------
function cleanAssistant(msg: any) {
  return { role: "assistant", content: msg.content ?? null, ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) };
}
// Gruppenbewusstes Trimmen: niemals mit einer haengenden tool- oder assistant(tool_calls)-Nachricht
// beginnen, sonst quittiert die OpenAI/OpenRouter-API den naechsten Call mit HTTP 400 und vergiftet die Session.
function trimMessages(msgs: any[], keep = 80): any[] {
  const arr = msgs.slice(-keep);
  while (arr.length && (arr[0].role === "tool" || (arr[0].role === "assistant" && arr[0].tool_calls?.length))) arr.shift();
  return arr;
}
// Best-effort-Persistenz: immer gruppenbewusst trimmen; Speicherfehler sind non-fatal (Loop laeuft weiter).
async function persistProgress(chat_id: number, state: any, messages: any[], vorgang: Vorgang) {
  state.messages = trimMessages(messages);
  try { await saveState(chat_id, state); } catch (e) { await audit(chat_id, null, "error", { stage: "saveState", error: String(e) }); }
  try { await saveVorgang(vorgang); } catch (e) { await audit(chat_id, null, "error", { stage: "saveVorgang", error: String(e) }); }
}
async function runAgent(chat_id: number, user_id: number, userContent: string) {
  const session = await getSession(chat_id, user_id);
  const state: any = session.current_state ?? { messages: [] };
  const messages: any[] = state.messages ?? [];
  const vorgang = await ensureVorgang(state, chat_id, user_id);
  vorgang.roh_eingaben = vorgang.roh_eingaben ?? [];
  vorgang.roh_eingaben.push({ ts: nowISO(), input: userContent.slice(0, 4000) });

  messages.push({ role: "user", content: userContent });
  const cfg = await getConfig();
  const system = buildSystemPrompt(cfg);

  await tgSend(chat_id, "🛠️ Einen Moment, ich arbeite das aus…");

  let pause = false, terminal = false;
  for (let i = 0; i < MAX_ITERS; i++) {
    let data: any;
    try { data = await orChat(cfg.llm_model ?? "openai/gpt-5.5", [{ role: "system", content: system }, ...messages], { tools: buildTools(cfg) }); }
    catch (e) {
      await audit(chat_id, user_id, "error", { stage: "llm", error: String(e) });
      await tgSend(chat_id, `⚠️ KI-Fehler: <code>${escapeHtml(String(e)).slice(0, 200)}</code>`);
      break;
    }
    const msg = data.choices?.[0]?.message;
    if (!msg) { await tgSend(chat_id, "⚠️ Keine Antwort vom Modell."); break; }
    messages.push(cleanAssistant(msg));

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      if (msg.content) await tgSend(chat_id, escapeHtml(msg.content));
      pause = true; break;
    }
    let stop = false;
    for (const tc of msg.tool_calls) {
      if (stop) {
        // Pause/Abschluss bereits ausgeloest -> restliche Tool-Calls NICHT ausfuehren, aber jede id beantworten.
        messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify({ status: "uebersprungen", grund: "Vorheriger Schritt erfordert erst eine Antwort bzw. ist abgeschlossen." }) });
        continue;
      }
      const res = await executeTool(tc, { chat_id, user_id, vorgang, cfg });
      messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(res.payload) });
      if (res.pause) { pause = true; stop = true; }
      if (res.terminal) { terminal = true; stop = true; }
    }
    await persistProgress(chat_id, state, messages, vorgang);
    if (pause || terminal) break;
    if (i === MAX_ITERS - 1) await tgSend(chat_id, "⚠️ Das war komplex — bitte praezisiere kurz, dann mache ich weiter.");
  }
  await persistProgress(chat_id, state, messages, vorgang);
}

// ---------- Eingangs-Handler ----------
async function handleText(chat_id: number, user_id: number, text: string) {
  if (/^\/(start|hilfe|help)/.test(text)) {
    await tgSend(chat_id,
      "<b>Aurora Angebots-Bot</b>\n\nBeschreibe ein Vorhaben per <b>Text</b>, <b>🎤 Sprachnachricht</b>, <b>📷 Foto</b> oder <b>📄 PDF</b>. " +
      "Ich finde die noetigen Angaben, frage Fehlendes nach, kalkuliere und schicke dir das Angebot als PDF (sevDesk).\n\n" +
      "<b>Befehle:</b>\n/neu — frischer Vorgang\n/abbrechen — aktuellen Vorgang verwerfen\n/hilfe — diese Uebersicht");
    return;
  }
  if (/^\/(neu|abbrechen)/.test(text)) { await clearSession(chat_id); await tgSend(chat_id, "Okay, frischer Start. Beschreibe dein neues Vorhaben."); return; }
  await runAgent(chat_id, user_id, text);
}
async function handleVoice(chat_id: number, user_id: number, file_id: string, size: number) {
  if (size > MAX_AUDIO_SIZE) { await tgSend(chat_id, "⚠️ Audio zu gross."); return; }
  await tgSend(chat_id, "🎤 Sprachnachricht empfangen, transkribiere…");
  const cfg = await getConfig();
  try {
    const meta = await tgGetFile(file_id);
    const file = await tgDownloadFile(meta.file_path);
    const fmt = normAudioFmt(file.filename);
    await audit(chat_id, user_id, "voice_format", { filename: file.filename, fmt });
    const transcript = await transcribeAudio(file.bytes, fmt, cfg.transcribe_model ?? "google/gemini-2.5-flash");
    if (!transcript) { await tgSend(chat_id, "⚠️ Konnte nichts Verstaendliches hoeren. Bitte nochmal."); return; }
    await audit(chat_id, user_id, "voice_transcribed", { transcript });
    await tgSend(chat_id, `🎤 <b>Verstanden:</b>\n<i>${escapeHtml(transcript)}</i>`);
    await runAgent(chat_id, user_id, transcript);
  } catch (e) {
    await audit(chat_id, user_id, "error", { stage: "voice", error: String(e) });
    await tgSend(chat_id, `⚠️ Transkriptionsfehler: <code>${escapeHtml(String(e)).slice(0, 200)}</code>`);
  }
}
async function handlePhoto(chat_id: number, user_id: number, photo: any[], caption?: string) {
  const largest = photo[photo.length - 1];
  if (!largest) return;
  if ((largest.file_size ?? 0) > MAX_IMAGE_SIZE) { await tgSend(chat_id, "⚠️ Bild zu gross."); return; }
  await tgSend(chat_id, "📷 Foto empfangen, analysiere…");
  const cfg = await getConfig();
  try {
    const meta = await tgGetFile(largest.file_id);
    const file = await tgDownloadFile(meta.file_path);
    const beschreibung = await describeImage(file.bytes, file.mime || "image/jpeg", cfg.vision_model ?? "openai/gpt-5.5");
    await audit(chat_id, user_id, "photo_described", { beschreibung });
    await tgSend(chat_id, `📷 <b>Auf dem Foto erkannt:</b>\n<i>${escapeHtml(beschreibung)}</i>`);
    await runAgent(chat_id, user_id, `[Foto-Inhalt] ${beschreibung}${caption ? `\n\nBildunterschrift: ${caption}` : ""}`);
  } catch (e) {
    await audit(chat_id, user_id, "error", { stage: "photo", error: String(e) });
    await tgSend(chat_id, `⚠️ Bildanalyse-Fehler: <code>${escapeHtml(String(e)).slice(0, 200)}</code>`);
  }
}
async function handleDocument(chat_id: number, user_id: number, doc: any, caption?: string) {
  const mime = (doc.mime_type ?? "").toLowerCase();
  const cfg = await getConfig();
  if (mime === "application/pdf") {
    if ((doc.file_size ?? 0) > MAX_PDF_SIZE) { await tgSend(chat_id, "⚠️ PDF zu gross."); return; }
    await tgSend(chat_id, "📄 PDF empfangen, lese Inhalt…");
    try {
      const meta = await tgGetFile(doc.file_id);
      const file = await tgDownloadFile(meta.file_path);
      const text = await extractPdfText(file.bytes, doc.file_name ?? "dokument.pdf", cfg.vision_model ?? "openai/gpt-5.5");
      if (!text) { await tgSend(chat_id, "⚠️ Aus dem PDF kam kein Text."); return; }
      await audit(chat_id, user_id, "pdf_extracted", { length: text.length });
      await runAgent(chat_id, user_id, `[PDF-Inhalt]${caption ? `\nBildunterschrift: ${caption}` : ""}\n\n${text.slice(0, 30000)}`);
    } catch (e) {
      await audit(chat_id, user_id, "error", { stage: "pdf", error: String(e) });
      await tgSend(chat_id, `⚠️ PDF-Fehler: <code>${escapeHtml(String(e)).slice(0, 200)}</code>`);
    }
    return;
  }
  if (mime.startsWith("image/")) { await handlePhoto(chat_id, user_id, [{ file_id: doc.file_id, file_size: doc.file_size }], caption); return; }
  await tgSend(chat_id, `ℹ️ Dateityp <code>${escapeHtml(mime || "unbekannt")}</code> wird nicht unterstuetzt. Sende Text, Sprache, Foto oder PDF.`);
}

async function handleCallback(cbq: any) {
  const data: string = cbq.data ?? "";
  const chat_id = cbq.message?.chat?.id; const user_id = cbq.from?.id;
  await tgAnswerCb(cbq.id);
  const [action, angebotId] = data.split(":");
  if (!angebotId) return;
  if (action === "approve") {
    await supabase.from("angebotsworkflow_angebote").update({ status: "freigegeben", freigegeben_at: nowISO() }).eq("id", angebotId);
    await tgSend(chat_id, "✅ Freigegeben. In sevDesk liegt das Angebot als Entwurf — dort kannst du es jetzt versenden.");
  } else if (action === "reject") {
    const { data: ang } = await supabase.from("angebotsworkflow_angebote").select("sevdesk_order_id").eq("id", angebotId).maybeSingle();
    await supabase.from("angebotsworkflow_angebote").update({ status: "abgesagt" }).eq("id", angebotId);
    if (ang?.sevdesk_order_id) await deleteSevOrder(ang.sevdesk_order_id);
    await tgSend(chat_id, "❌ Verworfen und aus sevDesk entfernt.");
  } else if (action === "edit") {
    await tgSend(chat_id, "✏️ Was soll geaendert werden? Schreib oder sprich die Aenderung (z.B. \"Position 3 streichen\" oder \"10% Nachlass auf Lohn\").");
  }
  await audit(chat_id, user_id, `callback:${action}`, { angebot_id: angebotId });
}

// ---------- Webhook ----------
async function handleUpdate(update: any) {
  const fromId = update.message?.from?.id ?? update.callback_query?.from?.id;
  const allowed = await getAllowedUserIds();
  if (allowed.size > 0 && fromId && !allowed.has(fromId)) { await audit(null, fromId, "unauthorized", { fromId }); return; }
  try {
    const m = update.message;
    if (update.callback_query) { await handleCallback(update.callback_query); return; }
    if (!m) return;
    const chat_id = m.chat.id; const user_id = m.from.id;
    if (m.text) { await audit(chat_id, user_id, "incoming_text", { text: m.text }); await handleText(chat_id, user_id, m.text); }
    else if (m.voice) { await audit(chat_id, user_id, "incoming_voice", { duration: m.voice.duration }); await handleVoice(chat_id, user_id, m.voice.file_id, m.voice.file_size ?? 0); }
    else if (m.audio) { await audit(chat_id, user_id, "incoming_audio", {}); await handleVoice(chat_id, user_id, m.audio.file_id, m.audio.file_size ?? 0); }
    else if (m.photo) { await audit(chat_id, user_id, "incoming_photo", { caption: m.caption }); await handlePhoto(chat_id, user_id, m.photo, m.caption); }
    else if (m.document) { await audit(chat_id, user_id, "incoming_document", { mime: m.document.mime_type }); await handleDocument(chat_id, user_id, m.document, m.caption); }
    else await tgSend(chat_id, "ℹ️ Unterstuetzt: Text, Sprachnachrichten, Fotos und PDFs.");
  } catch (e) {
    await audit(null, fromId ?? null, "error", { stage: "handler", error: String(e) });
  }
}

// ---------- Admin-Endpunkte (gegated durch ADMIN_KEY-Header x-admin-key) ----------
// Ermoeglichen autonomes Go-Live ohne Kenntnis der projektweiten Edge-Secrets:
//   ?admin=whoami       -> Bot-Identitaet (getMe)
//   ?admin=webhookinfo  -> aktueller Webhook-Status
//   ?admin=setwebhook   -> registriert den Webhook auf diese Function (eigenes Secret)
//   ?admin=test (POST)  -> injiziert ein Telegram-Update (Smoke-Test, ohne Telegram-Secret)
async function handleAdmin(action: string, req: Request): Promise<Response> {
  const selfUrl = `${SUPABASE_URL}/functions/v1/angebotsworkflow-telegram`;
  if (action === "whoami") {
    const r = await fetch(`${TG}/getMe`).then((x) => x.json()).catch((e) => ({ error: String(e) }));
    return Response.json({ has_token: !!TELEGRAM_BOT_TOKEN, bot: r?.result ?? r });
  }
  if (action === "webhookinfo") {
    const r = await fetch(`${TG}/getWebhookInfo`).then((x) => x.json()).catch((e) => ({ error: String(e) }));
    return Response.json(r);
  }
  if (action === "setwebhook") {
    const r = await fetch(`${TG}/setWebhook`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: selfUrl, secret_token: TELEGRAM_WEBHOOK_SECRET, allowed_updates: ["message", "callback_query"], drop_pending_updates: true }),
    }).then((x) => x.json()).catch((e) => ({ error: String(e) }));
    return Response.json({ url: selfUrl, setWebhook: r });
  }
  if (action === "test") {
    const update = await req.json().catch(() => null);
    if (!update) return Response.json({ error: "kein update im Body" }, { status: 400 });
    const work = handleUpdate(update).catch((e) => audit(null, null, "error", { stage: "admin_test", error: String(e) }));
    try { (globalThis as any).EdgeRuntime?.waitUntil?.(work); } catch { /* ignore */ }
    return Response.json({ ok: true, injected: true });
  }
  return Response.json({ error: "unbekannte Admin-Aktion" }, { status: 400 });
}

Deno.serve((req: Request) => {
  const miss = missingEnv();
  if (miss.length) { console.error("Fehlende Secrets:", miss.join(", ")); return new Response(`missing secrets: ${miss.join(", ")}`, { status: 500 }); }
  const adminAction = new URL(req.url).searchParams.get("admin");
  if (adminAction) {
    if (!ADMIN_KEY || (req.headers.get("x-admin-key") ?? "") !== ADMIN_KEY) return new Response("forbidden", { status: 403 });
    return handleAdmin(adminAction, req);
  }
  // Normaler Telegram-Pfad: Secret ist Pflicht -> jeder Request ohne korrekten Header wird abgelehnt.
  if ((req.headers.get("x-telegram-bot-api-secret-token") ?? "") !== TELEGRAM_WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  return req.json().then((update) => {
    const work = handleUpdate(update).catch((e) => audit(null, null, "error", { stage: "top", error: String(e) }));
    try { (globalThis as any).EdgeRuntime?.waitUntil?.(work); } catch { /* ignore */ }
    return new Response("ok", { status: 200 });
  }).catch(() => new Response("bad json", { status: 400 }));
});
