# Übergabe-Dokument — Aurora Angebots-Bot

**Stand: 14.06.2026.** Dieses Dokument hat Anspruch auf Vollständigkeit: Eine andere Claude-Code-Instanz
(auf **Ayses** Rechner) soll damit das laufende Gespräch **1:1 weiterführen** können, ohne Wissenslücke.
Lies zusätzlich `README.md` (Architektur/Bedienung) und `db/schema.sql` (Datenmodell).

---

## 0. Das Wichtigste in 60 Sekunden

- Der **Aurora Angebots-Bot** ist **gebaut, getestet und live** auf Telegram **@Aurorahaus_bot**.
- Monteur schickt Text/Sprache → KI (GPT-5.5 via OpenRouter) → RAG-Wissen + Preis-Kataloge (Supabase) →
  **sevDesk-Angebot + PDF** → zurück nach Telegram. Korrektur-Loop inklusive.
- **Alles läuft serverlos in Supabase** (Edge Functions). Kein eigener Server.
- **Supabase-Projekt `jobarrwnqnarahdpchfb` gehört Ayse** → keine Migration nötig.
- **Aktueller Zustand: die Preis-Kataloge sind noch DUMMY-Daten.** Es wurden bereits **16 Angebote**
  damit erzeugt (07.–11.06.) — die sind auf **Platzhalter-Preisen** kalkuliert, **nicht belastbar**.
- **Die aktuelle Aufgabe** (= warum übergeben wird): **echte Lieferanten-Preise** in den Material-Katalog
  bekommen — per **Browser-Automation/Webscraping auf Ayses Rechnern** (weil Großhändler-Passwörter im Spiel sind).

---

## 1. SCHNELLSTART auf Ayses Rechner (Weg A — eigene Codebasis)

Ziel: Ayse wird **Eigentümerin ihrer eigenen Codebasis** und arbeitet mit **demselben** Supabase-Projekt weiter.

### 1a. Eigenes (privates) Repo erstellen
Voraussetzung: Git installiert, GitHub-CLI `gh` auf Ayses Account angemeldet (`gh auth login`).
```bash
git clone https://github.com/quualle/aurora-angebotsbot.git
cd aurora-angebotsbot
rm -rf .git                       # Verbindung zu Marcos Repo kappen
git init -b main
git add -A
git commit -m "Aurora Angebots-Bot (eigene Kopie)"
gh repo create aurora-angebotsbot --private --source=. --remote=origin --push
```
→ Danach ist das Repo **privat unter Ayses GitHub-Account**, völlig losgelöst von Marco.

*(Ohne `gh`: leeres Repo auf github.com anlegen, dann `git remote add origin <DEINE-REPO-URL>` und `git push -u origin main`.)*

### 1b. Claude Code mit dem Supabase-Projekt verbinden
Die Datei **`.mcp.json`** im Repo zeigt bereits auf das richtige Projekt
(`mcp.supabase.com/mcp?project_ref=jobarrwnqnarahdpchfb`). In Claude Code im Projektordner einmal `/mcp`
ausführen und mit **Ayses Supabase-Login** authentifizieren. Danach hat der Claude Zugriff auf alle Tabellen,
Edge Functions und Secrets — **es muss nichts weiter übertragen werden** (Code = Repo, Daten + Secrets = DB).

### 1c. Weitermachen
Dieses Dokument + `README.md` lesen, dann bei **Abschnitt 4 (aktuelle Aufgabe)** ansetzen: echte
Lieferantenpreise beschaffen. Das Gespräch wird genau dort 1:1 fortgeführt.

---

## 2. Wo alles liegt

| Sache | Ort |
|---|---|
| Code | Ayses eigenes Repo (aus Weg A) · Original (public): https://github.com/quualle/aurora-angebotsbot |
| Supabase-Projekt | **`jobarrwnqnarahdpchfb`** (Ayses Konto) — `https://jobarrwnqnarahdpchfb.supabase.co` |
| Telegram-Bot | **@Aurorahaus_bot** (id 8705115032) |
| Edge Functions | `angebotsworkflow-telegram` (Bot/Agent) · `angebotsworkflow-embed` (Embeddings) |
| Tabellen | Präfix `angebotsworkflow_` (Schema-Snapshot in `db/schema.sql`) |
| sevDesk | Angebote (Order Typ `AN`, Status Entwurf) |

## 3. Was schon da ist / was NICHT übertragen werden muss

Alles liegt entweder im **Repo** (Code) oder in der **Supabase-DB** (Daten **+ Secrets** in Tabelle
`angebotsworkflow_secrets`). Da Supabase **schon Ayses Projekt** ist und das Repo geklont wird, ist
**kein separater „Datenblock"-Transfer nötig**. Zugriff = alles da.

## 4. Aktuelle Aufgabe (hier weitermachen)

**Echte Materialpreise der Lieferanten in `angebotsworkflow_material` bekommen.**

Entscheidung Marco/Ayse: **Browser-Automation/Webscraping**, ausgeführt auf **Ayses Rechnern**
(weil Großhändler-Logins/Passwörter nicht auf fremde Rechner sollen). Geplant: eine Routine/Cloud-Page,
die im von Ayse gewählten Intervall (z.B. 1×/Tag) per Browser-Usage die Preise zieht und **qualitätsgesichert**
nach Supabase schreibt.

**Profi-Hinweis unbedingt beachten:** Im deutschen SHK-/TGA-Großhandel ist die saubere Schnittstelle meist
**Datanorm** (Preisdatei-Download im B2B-Portal), **IDS-Connect** oder **OCI** — und die enthalten **Auroras
echte Einkaufskonditionen**, nicht nur Listenpreise. Öffentliches Webshop-Scraping liefert nur **Listenpreise**.
Daher pro Lieferanten zuerst prüfen: Datanorm-Export? IDS/OCI? REST-API? — erst dann Scraping als Notnagel.

**Zieltabelle `angebotsworkflow_material`** (Spalten u.a.): `kategorie, artikel_bezeichnung, hersteller,
lieferant, artikelnummer, einheit, einkaufspreis_netto, aufschlag_faktor` (→ `verkaufspreis_netto` wird
generiert), `gueltig_ab, quelle` (für Sync z.B. `sync:gc-gruppe`). **Wichtig:** Nach Katalog-Update für den
**Wissens**-Katalog `angebotsworkflow-embed` aufrufen; Material/Leistungen brauchen keine Embeddings (Trigram-Suche).

## 5. Secrets (Werte stehen NICHT hier — nur Orte)

Laufzeit-Secrets liegen in Tabelle **`angebotsworkflow_secrets`** (nur service-role lesbar):
`secret_openrouter_api_key`, `secret_voyage_api_key`, `secret_admin_key` (+ optional
`secret_telegram_bot_token`, `secret_telegram_webhook_secret`, `secret_sevdesk_api_token`).
Zusätzlich gibt es **projektweite Supabase Edge Secrets** aus dem Alt-Setup: `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_WEBHOOK_SECRET`, `SEVDESK_API_TOKEN`, `TELEGRAM_ALLOWED_USER_IDS`. Die Funktion liest **env-first,
sonst DB**. Auslesen: `select key from angebotsworkflow_secrets;`.

## 6. Admin-Endpunkte (Setup/Test ohne Secret-Kenntnis)

`POST .../functions/v1/angebotsworkflow-telegram?admin=<aktion>` mit Header `x-admin-key: <secret_admin_key>`:
- `whoami` — Bot-Identität · `webhookinfo` — Webhook-Status · `setwebhook` — Webhook setzen ·
- `test` (Body = Telegram-Update-JSON) — Vorgang injizieren (Smoke-Test).

## 7. Deploy / Re-Deploy

- Über **Supabase-MCP** (`deploy_edge_function`) — so initial geschehen.
- Oder **CLI**: `supabase functions deploy angebotsworkflow-telegram --no-verify-jwt --project-ref jobarrwnqnarahdpchfb`
- Schema: `db/schema.sql`. Katalog-Dummy laden: `seeds/` (`build_seeds.py`, `seed_wissen_embed.py`).

## 8. Offene Punkte / Entscheidungen

1. **16 Dummy-Angebote** in sevDesk prüfen/neu kalkulieren, sobald echte Preise da sind.
2. **Echte Lieferantenpreise** rein (= die aktuelle Aufgabe, Abschnitt 4).
3. **sevDesk-Token:** funktioniert (hat im Test real eine Order angelegt). Noch zu bestätigen: gehört der
   projektweite `SEVDESK_API_TOKEN` wirklich **Auroras** sevDesk-Account? (am einfachsten direkt in sevDesk gegenchecken).
4. **Härtung:** DB-Secrets → Supabase Edge Secrets/Vault; `secret_admin_key` rotieren.
5. **Echte Leistungspreise** (`angebotsworkflow_leistungen`) ebenfalls durch Auroras echte Sätze ersetzen.

## 9. Gesprächskontext (damit 1:1 weitergeht)

Wir kommen aus der Bau- und Abnahmephase (System steht, live, getestet) und sind jetzt bei **„echte Daten
befüllen"**. Konkret heute: Ayse + Marco sammeln die **Lieferanten**; die Preisbeschaffung wird **Browser-
Automation auf Ayses Rechnern** (Passwörter!), Intervall nach Ayses Wunsch, qualitätsgesichert nach Supabase.
Nächster konkreter Schritt: **Lieferantenliste** durchgehen und je Lieferant Datanorm/IDS/OCI/API vs. Scraping
festlegen (Abschnitt 4).
