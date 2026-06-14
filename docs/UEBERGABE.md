# Übergabe-Dokument — Aurora Angebots-Bot

**Stand: 14.06.2026.** Dieses Dokument hat Anspruch auf Vollständigkeit: Eine andere Claude-Code-Instanz
(auf IISEs/Ayses Rechner) soll damit das laufende Gespräch **1:1 weiterführen** können, ohne Wissenslücke.
Lies zusätzlich `README.md` (Architektur/Bedienung) und `db/schema.sql` (Datenmodell).

---

## 0. Das Wichtigste in 60 Sekunden

- Der **Aurora Angebots-Bot** ist **gebaut, getestet und live** auf Telegram **@Aurorahaus_bot**.
- Monteur schickt Text/Sprache → KI (GPT-5.5 via OpenRouter) → RAG-Wissen + Preis-Kataloge (Supabase) →
  **sevDesk-Angebot + PDF** → zurück nach Telegram. Korrektur-Loop inklusive.
- **Alles läuft serverlos in Supabase** (Edge Functions). Kein eigener Server.
- **Aktueller Zustand: die Preis-Kataloge sind noch DUMMY-Daten.** Es wurden bereits **16 Angebote**
  damit erzeugt (07.–11.06.) — die sind auf **Platzhalter-Preisen** kalkuliert, **nicht belastbar**.
- **Die aktuelle Aufgabe** (= warum übergeben wird): **echte Lieferanten-Preise** in den Material-Katalog
  bekommen — per **Browser-Automation/Webscraping auf IISE-Rechnern** (weil Großhändler-Passwörter im Spiel sind).

## 1. Wo alles liegt

| Sache | Ort |
|---|---|
| Code | GitHub (public): **https://github.com/quualle/aurora-angebotsbot** |
| Supabase-Projekt | Ref **`jobarrwnqnarahdpchfb`** (URL `https://jobarrwnqnarahdpchfb.supabase.co`) |
| Telegram-Bot | **@Aurorahaus_bot** (id 8705115032) |
| Edge Functions | `angebotsworkflow-telegram` (Bot/Agent) · `angebotsworkflow-embed` (Embeddings) |
| Tabellen | Präfix `angebotsworkflow_` (Schema-Snapshot in `db/schema.sql`) |
| sevDesk | Angebote (Order Typ `AN`, Status Entwurf) |

## 2. Was die IISE-Maschine braucht (Zugänge)

1. **Supabase-Zugriff auf Projekt `jobarrwnqnarahdpchfb`** — per MCP-Server
   (`https://mcp.supabase.com/mcp?project_ref=jobarrwnqnarahdpchfb`, siehe `.mcp.json`) **oder** Account-Login.
   ❗ **OFFENE FRAGE: Gehört dieses Projekt bereits IISE/Ayse?**
   - **Ja** → alles liegt schon dort, nichts migrieren. Einfach mit demselben Projekt weiterarbeiten.
   - **Nein** (anderes Konto) → Migration nötig: Schema (`db/schema.sql`) + Katalog-Daten (`seeds/`) +
     Secrets in ein IISE-eigenes Supabase-Projekt übertragen, Edge Functions dort neu deployen,
     Telegram-Webhook umbiegen.
2. **GitHub-Repo** (public, einfach klonen).
3. **Sonst nichts** — alle Laufzeit-Secrets liegen in der DB (s. Abschnitt 4). Wenn Supabase + Repo da sind,
   ist alles da. **Kein separater „Datenblock"-Transfer nötig.**

## 3. Aktuelle Aufgabe (hier weitermachen)

**Echte Materialpreise der Lieferanten in `angebotsworkflow_material` bekommen.**

Entscheidung Marco/Ayse: **Browser-Automation/Webscraping**, ausgeführt auf **IISE-Rechnern**
(weil Großhändler-Logins/Passwörter nicht auf fremde Rechner sollen). Geplant: eine Routine/Cloud-Page,
die im von Ayse gewählten Intervall (z.B. 1×/Tag) per Browser-Usage die Preise zieht und **qualitätsgesichert**
nach Supabase schreibt.

**Profi-Hinweis unbedingt beachten:** Im deutschen SHK-/TGA-Großhandel ist die saubere Schnittstelle meist
**Datanorm** (Preisdatei-Download im B2B-Portal), **IDS-Connect** oder **OCI** — und die enthalten **Auroras
echte Einkaufskonditionen**, nicht nur Listenpreise. Öffentliches Webshop-Scraping liefert nur **Listenpreise**.
Daher pro Lieferanten zuerst prüfen: Datanorm-Export? IDS/OCI? REST-API? — erst dann Scraping als Notnagel.

**Zieltabelle `angebotsworkflow_material`** (Spalten u.a.): `kategorie, artikel_bezeichnung, hersteller,
lieferant, artikelnummer, einheit, einkaufspreis_netto, aufschlag_faktor` (→ `verkaufspreis_netto` wird
generiert), `gueltig_ab, quelle` (für Sync: z.B. `sync:gc-gruppe`). **Wichtig:** Nach Katalog-Update für den
**Wissens**-Katalog `angebotsworkflow-embed` aufrufen; Material/Leistungen brauchen keine Embeddings (Trigram-Suche).

## 4. Secrets (Werte stehen NICHT hier — nur Orte)

Laufzeit-Secrets liegen in Tabelle **`angebotsworkflow_secrets`** (nur service-role lesbar):
`secret_openrouter_api_key`, `secret_voyage_api_key`, `secret_admin_key` (+ optional
`secret_telegram_bot_token`, `secret_telegram_webhook_secret`, `secret_sevdesk_api_token`).
Zusätzlich gibt es **projektweite Supabase Edge Secrets** aus dem Alt-Setup: `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_WEBHOOK_SECRET`, `SEVDESK_API_TOKEN`, `TELEGRAM_ALLOWED_USER_IDS`. Die Funktion liest **env-first,
sonst DB**. → Beim Migrieren auf ein neues Konto müssen diese Secrets neu gesetzt werden.

Auslesen (mit Supabase-Zugriff): `select key from angebotsworkflow_secrets;` bzw. Wert per
`select value from angebotsworkflow_secrets where key='...';`.

## 5. Admin-Endpunkte (Setup/Test ohne Secret-Kenntnis)

`POST .../functions/v1/angebotsworkflow-telegram?admin=<aktion>` mit Header `x-admin-key: <secret_admin_key>`:
- `whoami` — Bot-Identität · `webhookinfo` — Webhook-Status · `setwebhook` — Webhook auf diese Funktion setzen ·
- `test` (Body = Telegram-Update-JSON) — Vorgang injizieren (Smoke-Test).

## 6. Deploy / Re-Deploy

- Über **Supabase-MCP** (`deploy_edge_function`) — so initial geschehen.
- Oder **CLI** (wenn auf dem richtigen Konto angemeldet):
  `supabase functions deploy angebotsworkflow-telegram --no-verify-jwt --project-ref <ref>`
- Schema neu aufsetzen: `db/schema.sql` anwenden. Katalog-Dummy laden: `seeds/` (siehe `seeds/build_seeds.py`,
  `seeds/seed_wissen_embed.py`).

## 7. Offene Punkte / Entscheidungen

1. **Whose Supabase?** (Abschnitt 2.1) — vor allem anderen klären.
2. **16 Dummy-Angebote** in sevDesk prüfen/neu kalkulieren, sobald echte Preise da sind.
3. **Echte Lieferantenpreise** rein (= die aktuelle Aufgabe, Abschnitt 3).
4. **sevDesk-Token:** funktioniert (hat im Test real eine Order angelegt). Noch zu bestätigen: gehört der
   projektweite `SEVDESK_API_TOKEN` wirklich **Auroras** sevDesk-Account? (per `?admin=` nicht abfragbar;
   am einfachsten direkt in sevDesk gegenchecken oder Token gegen `/SevUser` prüfen.)
5. **Härtung:** DB-Secrets → Supabase Edge Secrets/Vault; `secret_admin_key` rotieren.
6. **Echte Leistungspreise** (`angebotsworkflow_leistungen`) ebenfalls durch Auroras echte Sätze ersetzen.

## 8. Gesprächskontext (damit 1:1 weitergeht)

Wir kommen aus der Bau- und Abnahmephase (System steht, live, getestet) und sind jetzt bei **„echte Daten
befüllen"**. Konkret heute: Ayse + Marco sammeln die **Lieferanten**; die Preisbeschaffung wird **Browser-
Automation auf IISE-Rechnern** (Passwörter!), Intervall nach Ayses Wunsch, qualitätsgesichert nach Supabase.
Nächster konkreter Schritt: **Lieferantenliste** durchgehen und je Lieferant Datanorm/IDS/OCI/API vs. Scraping
festlegen (Abschnitt 3).
