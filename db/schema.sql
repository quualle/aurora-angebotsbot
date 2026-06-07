-- =============================================================
-- Aurora Angebotsworkflow — DB-Schema (Snapshot)
-- Supabase-Projekt jobarrwnqnarahdpchfb. Alle Objekte mit Praefix angebotsworkflow_.
-- Wurde via Supabase MCP apply_migration angewandt; hier als reproduzierbarer Snapshot.
-- =============================================================
create extension if not exists vector;
create extension if not exists pg_trgm;

-- ---------- Kataloge ----------
create table if not exists angebotsworkflow_wissen (
  id bigint generated always as identity primary key,
  gewerk text not null,
  typ text not null check (typ in ('wenn_dann','howto','norm','leistungsuebersicht')),
  titel text not null,
  inhalt text not null,
  tags text[] not null default '{}',
  metadata jsonb not null default '{}',
  embedding vector(1024),
  such_text text generated always as (titel || ' ' || inhalt) stored,
  created_at timestamptz not null default now()
);
create index if not exists angebotsworkflow_wissen_emb_idx on angebotsworkflow_wissen using hnsw (embedding vector_cosine_ops);
create index if not exists angebotsworkflow_wissen_trgm_idx on angebotsworkflow_wissen using gin (such_text gin_trgm_ops);
create index if not exists angebotsworkflow_wissen_tags_idx on angebotsworkflow_wissen using gin (tags);
create index if not exists angebotsworkflow_wissen_gewerk_idx on angebotsworkflow_wissen (gewerk);
alter table angebotsworkflow_wissen enable row level security;

create table if not exists angebotsworkflow_leistungen (
  id bigint generated always as identity primary key,
  gewerk text not null,
  leistung_code text unique,
  bezeichnung text not null,
  beschreibung text,
  einheit text not null,
  einzelpreis_netto numeric not null,
  kalkulationsbasis text,
  tags text[] not null default '{}',
  aktiv boolean not null default true,
  embedding vector(1024),
  such_text text generated always as (bezeichnung || ' ' || coalesce(beschreibung,'') || ' ' || coalesce(leistung_code,'')) stored,
  created_at timestamptz not null default now()
);
create index if not exists angebotsworkflow_leistungen_emb_idx on angebotsworkflow_leistungen using hnsw (embedding vector_cosine_ops);
create index if not exists angebotsworkflow_leistungen_trgm_idx on angebotsworkflow_leistungen using gin (such_text gin_trgm_ops);
create index if not exists angebotsworkflow_leistungen_gewerk_idx on angebotsworkflow_leistungen (gewerk);
alter table angebotsworkflow_leistungen enable row level security;

create table if not exists angebotsworkflow_material (
  id bigint generated always as identity primary key,
  kategorie text not null,
  artikel_bezeichnung text not null,
  hersteller text,
  lieferant text,
  artikelnummer text,
  einheit text not null,
  einkaufspreis_netto numeric not null,
  aufschlag_faktor numeric not null default 1.10,
  verkaufspreis_netto numeric generated always as (round(einkaufspreis_netto * aufschlag_faktor, 2)) stored,
  listenpreis_netto numeric,
  gueltig_ab date not null default current_date,
  quelle text not null default 'dummy',
  tags text[] not null default '{}',
  embedding vector(1024),
  such_text text generated always as (artikel_bezeichnung || ' ' || coalesce(hersteller,'') || ' ' || coalesce(artikelnummer,'') || ' ' || kategorie) stored,
  created_at timestamptz not null default now()
);
create index if not exists angebotsworkflow_material_emb_idx on angebotsworkflow_material using hnsw (embedding vector_cosine_ops);
create index if not exists angebotsworkflow_material_trgm_idx on angebotsworkflow_material using gin (such_text gin_trgm_ops);
create index if not exists angebotsworkflow_material_kat_idx on angebotsworkflow_material (kategorie);
alter table angebotsworkflow_material enable row level security;

-- ---------- Such-/Match-Funktionen ----------
create or replace function angebotsworkflow_match_wissen(query_embedding vector(1024), match_count int default 6, filter_gewerk text default null)
returns table (id bigint, gewerk text, typ text, titel text, inhalt text, tags text[], aehnlichkeit float)
language sql stable as $$
  select w.id, w.gewerk, w.typ, w.titel, w.inhalt, w.tags, 1 - (w.embedding <=> query_embedding)
  from angebotsworkflow_wissen w where w.embedding is not null and (filter_gewerk is null or w.gewerk = filter_gewerk)
  order by w.embedding <=> query_embedding limit match_count;
$$;
create or replace function angebotsworkflow_search_leistungen(q text, match_count int default 8, filter_gewerk text default null)
returns table(id bigint, gewerk text, leistung_code text, bezeichnung text, beschreibung text, einheit text, einzelpreis_netto numeric, kalkulationsbasis text, score real)
language sql stable as $$
  select l.id,l.gewerk,l.leistung_code,l.bezeichnung,l.beschreibung,l.einheit,l.einzelpreis_netto,l.kalkulationsbasis, similarity(l.such_text,q)::real
  from angebotsworkflow_leistungen l where l.aktiv and (filter_gewerk is null or l.gewerk=filter_gewerk)
    and (l.such_text ilike ('%'||q||'%') or similarity(l.such_text,q) > 0.08)
  order by similarity(l.such_text,q) desc limit match_count;
$$;
create or replace function angebotsworkflow_search_material(q text, match_count int default 8, filter_kategorie text default null)
returns table(id bigint, kategorie text, artikel_bezeichnung text, hersteller text, lieferant text, artikelnummer text, einheit text, einkaufspreis_netto numeric, verkaufspreis_netto numeric, score real)
language sql stable as $$
  select m.id,m.kategorie,m.artikel_bezeichnung,m.hersteller,m.lieferant,m.artikelnummer,m.einheit,m.einkaufspreis_netto,m.verkaufspreis_netto, similarity(m.such_text,q)::real
  from angebotsworkflow_material m where (filter_kategorie is null or m.kategorie=filter_kategorie)
    and (m.such_text ilike ('%'||q||'%') or similarity(m.such_text,q) > 0.08)
  order by similarity(m.such_text,q) desc limit match_count;
$$;

-- ---------- Operative Tabellen ----------
create table if not exists angebotsworkflow_kunden (
  id uuid primary key default gen_random_uuid(),
  sevdesk_contact_id bigint unique,
  name text not null, vorname text, firma text,
  anschrift_strasse text, anschrift_plz text, anschrift_ort text,
  telefon text, email text, notizen text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table angebotsworkflow_kunden enable row level security;

create table if not exists angebotsworkflow_angebote (
  id uuid primary key default gen_random_uuid(),
  sevdesk_order_id bigint unique, sevdesk_order_nr text,
  kunde_id uuid references angebotsworkflow_kunden(id),
  vorgang_id uuid,
  gewerk text not null check (gewerk in ('heizung','klima','lueftung','sanitaer','kaelte','elektro','gebaeudeautomation','mehrere','sonstiges')),
  bezeichnung text not null, telegram_chat_id bigint,
  status text not null default 'draft' check (status in ('draft','freigegeben','abgesagt','geaendert')),
  summe_netto numeric, ziel_rahmen_min numeric, ziel_rahmen_max numeric,
  pdf_storage_path text, ai_zusammenfassung text, ai_annahmen jsonb not null default '[]',
  version int not null default 1, parent_angebot_id uuid references angebotsworkflow_angebote(id),
  created_at timestamptz not null default now(), freigegeben_at timestamptz
);
alter table angebotsworkflow_angebote enable row level security;

create table if not exists angebotsworkflow_angebote_positionen (
  id uuid primary key default gen_random_uuid(),
  angebot_id uuid not null references angebotsworkflow_angebote(id) on delete cascade,
  position_nr int not null, bezeichnung text not null, beschreibung text,
  menge numeric not null, einheit text not null, einzelpreis_netto numeric not null, gesamt_netto numeric not null,
  kategorie text check (kategorie in ('material','lohn','demontage','anfahrt','nebengewerk','sonstiges')),
  is_assumption boolean not null default false, quelle text, created_at timestamptz not null default now()
);
alter table angebotsworkflow_angebote_positionen enable row level security;

create table if not exists angebotsworkflow_vorgaenge (
  id uuid primary key default gen_random_uuid(),
  telegram_chat_id bigint not null, telegram_user_id bigint, status text not null default 'offen',
  roh_eingaben jsonb not null default '[]', extrahierter_auftrag jsonb, wissens_treffer jsonb not null default '[]',
  hitl_verlauf jsonb not null default '[]', kalkulation jsonb,
  angebot_id uuid references angebotsworkflow_angebote(id), pdf_storage_path text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table angebotsworkflow_vorgaenge enable row level security;
alter table angebotsworkflow_angebote add constraint angebotsworkflow_angebote_vorgang_fk foreign key (vorgang_id) references angebotsworkflow_vorgaenge(id);

create table if not exists angebotsworkflow_sessions (
  telegram_chat_id bigint primary key, telegram_user_id bigint,
  current_state jsonb not null default '{}',
  draft_angebot_id uuid references angebotsworkflow_angebote(id),
  vorgang_id uuid references angebotsworkflow_vorgaenge(id),
  last_activity_at timestamptz not null default now(), created_at timestamptz not null default now()
);
alter table angebotsworkflow_sessions enable row level security;

create table if not exists angebotsworkflow_audit_log (
  id bigint generated always as identity primary key,
  telegram_chat_id bigint, telegram_user_id bigint, event_type text not null, payload jsonb,
  created_at timestamptz not null default now()
);
create index if not exists angebotsworkflow_audit_chat_idx on angebotsworkflow_audit_log (telegram_chat_id, created_at desc);
alter table angebotsworkflow_audit_log enable row level security;

create table if not exists angebotsworkflow_allowed_users (
  telegram_user_id bigint primary key, display_name text,
  role text not null default 'user' check (role in ('admin','user')),
  added_at timestamptz not null default now(), added_by text, notes text
);
alter table angebotsworkflow_allowed_users enable row level security;

create table if not exists angebotsworkflow_config (
  key text primary key, value jsonb not null, beschreibung text, updated_at timestamptz not null default now()
);
alter table angebotsworkflow_config enable row level security;

create table if not exists angebotsworkflow_secrets (
  key text primary key, value text not null, updated_at timestamptz not null default now()
);
alter table angebotsworkflow_secrets enable row level security;

-- ---------- Standard-Konfiguration ----------
insert into angebotsworkflow_config (key, value, beschreibung) values
  ('material_live_recherche_enabled','false','Live-Webrecherche fuer Materialpreise (Standard aus)'),
  ('stundensaetze_netto','{"helfer":58,"monteur":72,"meister":95}','Stundensaetze netto je Rolle in EUR'),
  ('anfahrtspauschale_netto','45','Anfahrtspauschale netto in EUR'),
  ('material_aufschlag_faktor','1.10','Standard-Aufschlag auf Materialeinkaufspreise'),
  ('agk_prozent','8','Allgemeine Geschaeftskosten in Prozent'),
  ('wg_prozent','10','Wagnis und Gewinn in Prozent'),
  ('mwst_prozent','19','Mehrwertsteuer in Prozent'),
  ('llm_model','"openai/gpt-5.5"','OpenRouter-Modell fuer den Agenten'),
  ('transcribe_model','"google/gemini-2.5-flash"','OpenRouter-Modell fuer Transkription'),
  ('vision_model','"openai/gpt-5.5"','OpenRouter-Modell fuer Bildanalyse')
on conflict (key) do nothing;

-- ---------- Storage-Bucket (privat) ----------
insert into storage.buckets (id, name, public) values ('angebotsworkflow-angebote','angebotsworkflow-angebote',false)
on conflict (id) do nothing;
