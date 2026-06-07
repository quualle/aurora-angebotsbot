# sevDesk — Angebotserstellung (API-Ablauf)

Notation der Endpoint-Reihenfolge, mit der `angebotsworkflow-telegram` ein Angebot (Order Typ `AN`)
anlegt. Basis-URL: `https://my.sevdesk.de/api/v1`.

## Authentifizierung
Header `Authorization: <API-TOKEN>` — **ohne** `Bearer`-Präfix. Token als Edge-Secret `SEVDESK_API_TOKEN`.

## Reihenfolge (für ein Angebot)

| Schritt | Methode + Endpoint | Zweck |
|---|---|---|
| 1 | `GET /Contact?depth=1&name=<name>` | Kunde suchen |
| 1a | `POST /Contact` | Kunde anlegen falls nicht gefunden. `category.id` = **3** (Firma) bzw. **4** (Person) |
| 1b | `POST /ContactAddress` | Anschrift (street/zip/city, `country.id`=1 = DE) |
| 1c | `POST /CommunicationWay` | Telefon (`key.id`=103) und/oder E-Mail (`key.id`=109) |
| 2 | `GET /SevUser` | eigene User-ID → `contactPerson` |
| 3 | `GET /SevSequence/Factory/getByType?objectType=Order&type=AN` | nächste Angebotsnummer (Fallback: Zeitstempel `AN-…`) |
| 4 | `GET /Unity?limit=100` | Einheiten-Mapping (Stk/m/m²/h/Psch → `unity.id`) |
| 5 | `POST /Order` | Angebotskopf anlegen → liefert `objects.id`, `objects.orderNumber` |
| 6 | `POST /OrderPos` (je Position) | Positionen anhängen |
| 7 | `GET /Order/{id}/getPdf` | PDF als Base64 (`objects.content`) |
| (E) | `DELETE /Order/{id}` | Rollback bei Positions-Fehler / Verwerfen / Ersetzen bei Korrektur |

## Order-Kopf (Schritt 5) — wichtige Felder
- `orderType: "AN"`, `status: 100` (= **Entwurf**; Versand bleibt manuell in sevDesk)
- `contact.id`, `contactPerson.id` (SevUser), `orderDate` (YYYY-MM-DD)
- `header` = Bezeichnung, `headText`/`footText`, Adressfelder `addressName/Street/Zip/City`, `addressCountry.id`=1
- `taxRate: 19`, `taxType: "default"`, `currency: "EUR"`, `showNet: true`, `version: 0`, `discount: 0`

## OrderPos (Schritt 6) — je Position
- `order.id`, `quantity` (= Menge), `price` (= **Einzelpreis netto**), `name`, `text` (Beschreibung)
- `unity.id` (aus Schritt 4), `taxRate: 19`, `positionNumber` (1..N)
- Alle Preise **netto**; MwSt rechnet sevDesk über `taxRate`.

## Einheiten-Mapping (Schritt 4)
`GET /Unity` liefert Einheiten mit `unitCode/translationCode/name`. Der Bot mappt gängige Einheiten
(`Stk, m, m², m³, h, kg, l, Psch`) inkl. Aliassen auf die `unity.id`. Unbekannte Einheit → erste verfügbare als Fallback.

## Nach sevDesk
- PDF (Base64) → dekodiert → Supabase Storage Bucket `angebotsworkflow-angebote`, Pfad `<chat_id>/<orderNr>_v<version>.pdf`.
- Angebot + Positionen → `angebotsworkflow_angebote` / `angebotsworkflow_angebote_positionen`.
- Bei Korrektur: neue Version anlegen, Eltern-Angebot auf `geaendert` setzen, alte sevDesk-Order löschen.

## Stolperfallen
- `Authorization` ohne `Bearer`.
- Preise immer netto; `showNet: true`.
- `category.id` 3 vs. 4 nicht verwechseln (Firma/Person).
- Schlägt das Anlegen einer Position fehl, wird die ganze Order wieder gelöscht (kein halbes Angebot).
