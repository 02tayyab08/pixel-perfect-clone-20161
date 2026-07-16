-- ============================================================
-- 02 — SALNI V3 FINAL SCHEMA (LOCKED · CANONICAL SOURCE OF TRUTH)
-- Supersedes 02_FINAL_SCHEMA_V2_1.sql. Any change to the data model
-- is made in THIS file first, then migrated. Never let Lovable or
-- Cursor improvise schema; verify all generated code against this file.
--
-- V3 DELTAS over V2.1 (all already applied to the live database —
-- existing DBs need NOTHING run; fresh deploys run this whole file):
--  * EXPLICIT GRANT BLOCK (public + storage schemas). Supabase's
--    default grants are NOT guaranteed on manually-run schema files;
--    their absence caused live 42501 "permission denied for table"
--    errors for BOTH authenticated and service_role (service_role
--    bypasses RLS but still needs table-level grants). Grants gate
--    table access one layer BELOW RLS; RLS still gates rows.
--  * organizations.lead_capture_enabled (boolean, default true) —
--    per-org switch for widget lead capture ("internal-use mode",
--    driven by a real customer requirement).
--  * Operational facts encoded as comments so nobody re-learns them
--    the hard way: widget conversations use channel 'text' (there is
--    no 'widget' enum value); Gemini File Search document deletion
--    requires force:true; documents.list page_size max is 20; new
--    uploads chunk at 200 tokens / 20 overlap (app-level, applies at
--    ingestion only).
--
-- V2.1 incorporated five adversarial-review rounds:
--  R1: layered rate limiting; claim-with-SKIP-LOCKED; storage-file
--      deletion in the delete flow; allowed_domains origin check;
--      single-step consent; race-safe store bootstrap; sweeper no
--      longer fails 'queued' docs prematurely.
--  R2: dedicated-store deletion on churn; CRON_WEBHOOK_SECRET (the
--      service key never enters pg_net logs); phone/email dedup.
--  R3: read-before-write lead dedup with FOR UPDATE; sharded hourly
--      org ceiling (lock-free under attack, bounded, no reaper);
--      single deleteStore for dedicated-store offboarding.
--  R4: Storage bucket fileSizeLimit 50 MB + allowedMimeTypes;
--      processor-side size recheck; 50 MB aligned here.
--  R5: row-first upload flow + advisory-locked BEFORE INSERT cap
--      trigger on documents (closes the TOCTOU billing bypass).
--
-- Standing design notes:
--  * Tenancy: ONE shared Gemini File Search store (app_config key
--    'shared_file_search_store'); per-document metadata
--    {org_id, document_id}; per-query SERVER-injected metadataFilter.
--    organizations.file_search_store_name (nullable) = shard /
--    dedicated-store override (ADR-02).
--  * Billing MANUAL in V1: seeded plans table; operator-managed
--    subscriptions; Stripe columns + processed_stripe_events DORMANT.
--  * Doc caps enforced ATOMICALLY by trigger (law) + friendly RPC
--    pre-check (UX). Answer caps monitored only (ADR-06); the hourly
--    org ceiling below is quota/abuse protection, not billing.
--  * No client DELETE on documents; no client INSERT/DELETE on
--    organizations. Creation via create_organization(); deletion via
--    the delete Edge Function (Gemini first, storage second, rows
--    last) (ADR-08).
--  * UTC everywhere; RLS on every table; SECURITY DEFINER + explicit
--    grants on every backend function.
-- ============================================================

create extension if not exists pgcrypto;
-- Enable in Supabase Dashboard → Database → Extensions, then run:
-- create extension if not exists pg_cron;
-- create extension if not exists pg_net;

-- ---------- ENUM TYPES ----------
create type member_role          as enum ('owner', 'admin', 'agent');
create type doc_status           as enum ('queued', 'indexing', 'ready', 'failed');
create type conversation_channel as enum ('text', 'voice');   -- 'voice' dormant until V2 (ADR-09)
create type message_role         as enum ('user', 'assistant', 'system');
create type message_modality     as enum ('text', 'voice');   -- 'voice' dormant until V2 (ADR-09)
create type lead_status          as enum ('new', 'qualified', 'contacted', 'converted', 'archived');
create type subscription_status  as enum ('trialing', 'active', 'past_due', 'paused', 'canceled');
create type app_locale           as enum ('en', 'ar');

-- ---------- UPDATED_AT TRIGGER FUNCTION ----------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------- REFERENCE & CONFIG ----------
create table public.plans (
  code               text primary key,
  name               text not null,
  monthly_price_aed  numeric(10,2) not null check (monthly_price_aed > 0),
  annual_price_aed   numeric(10,2) not null check (annual_price_aed > 0),
  doc_cap            integer not null check (doc_cap > 0),
  monthly_query_cap  integer not null check (monthly_query_cap > 0),
  seat_cap           integer,                              -- null = unlimited
  sort_order         integer not null default 0,
  is_active          boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

insert into public.plans (code, name, monthly_price_aed, annual_price_aed, doc_cap, monthly_query_cap, seat_cap, sort_order) values
  ('starter', 'Starter',   349.00,  3490.00,  15,  500,  2,    1),
  ('growth',  'Growth',    749.00,  7490.00,  50,  2000, 5,    2),
  ('scale',   'Scale',    1499.00, 14990.00, 150,  6000, null, 3);

-- Service-role-only key/value config.
-- Key 'shared_file_search_store' holds either a bootstrap sentinel
-- {"status":"creating","claimed_at":...} or the final
-- {"status":"ready","store_name":"fileSearchStores/..."} — managed
-- exclusively by claim_store_bootstrap()/finalize_store_bootstrap().
create table public.app_config (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- ---------- CORE TENANT TABLES ----------
create table public.organizations (
  id                     uuid primary key default gen_random_uuid(),
  name                   text not null check (char_length(name) between 2 and 120),
  slug                   text not null unique
                         check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) between 3 and 63),
  logo_url               text,
  brand_color            text not null default '#0F172A',
  assistant_name         text not null default 'Salni',
  default_locale         app_locale not null default 'en',
  system_instruction     text not null default
    'You are the knowledge assistant for this business. Answer using ONLY information retrieved from the uploaded documents via File Search. Never use outside knowledge. Cite the source document for each claim. If the documents do not contain the answer, reply exactly: "I don''t have that in the provided documents." Never guess.',
  file_search_store_name text,                             -- NULL = shared store; set = shard/dedicated override
  allowed_domains        text[],                           -- NULL = allow all; else Origin allow-list for the widget (defense-in-depth, R1)
  lead_capture_enabled   boolean not null default true,    -- V3: widget lead-capture switch; false = internal-use mode (capture_lead tool not declared, capture addendum not appended)
  is_active              boolean not null default true,    -- manual billing gate (ADR-04)
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create table public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  full_name  text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.organization_members (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  role            member_role not null default 'agent',
  created_at      timestamptz not null default now(),
  unique (organization_id, user_id)
);

-- ---------- DOCUMENTS ----------
-- V2.1 flow is ROW-FIRST: insert this row (cap trigger fires here),
-- THEN upload the file to Storage at storage_path. A rejected insert
-- therefore never leaves an orphaned file (R5).
create table public.documents (
  id                        uuid primary key default gen_random_uuid(),
  organization_id           uuid not null references public.organizations(id) on delete cascade,
  uploaded_by               uuid references public.profiles(id) on delete set null,
  file_name                 text not null,
  mime_type                 text,
  size_bytes                bigint check (size_bytes is null or (size_bytes > 0 and size_bytes <= 52428800)),  -- 50 MB (R4; bucket enforces the same)
  storage_path              text,                          -- private bucket 'documents'; path = <org_id>/<document_id>/<file_name>
  file_search_document_name text,                          -- resource name inside the File Search store
  status                    doc_status not null default 'queued',
  language                  app_locale,
  error_message             text,
  retry_count               integer not null default 0,
  indexed_at                timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

-- ---------- CONVERSATIONS & MESSAGES ----------
create table public.conversations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  channel         conversation_channel not null default 'text',  -- widget ALSO uses 'text' (no 'widget' enum value); widget turns = started_by IS NULL + end_user_ref set
  locale          app_locale not null default 'en',
  started_by      uuid references public.profiles(id) on delete set null,  -- null for anonymous visitors
  end_user_ref    text,                                    -- widget UUID from localStorage (rehydration + friendly rate-limit key)
  title           text,
  last_message_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table public.messages (
  id                uuid primary key default gen_random_uuid(),
  conversation_id   uuid not null references public.conversations(id) on delete cascade,
  organization_id   uuid not null references public.organizations(id) on delete cascade,  -- denormalized for RLS/perf
  role              message_role not null,
  modality          message_modality not null default 'text',
  content           text not null,
  model             text,
  prompt_tokens     integer,
  completion_tokens integer,
  latency_ms        integer,
  created_at        timestamptz not null default now()
);

create table public.citations (
  id              uuid primary key default gen_random_uuid(),
  message_id      uuid not null references public.messages(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  document_id     uuid references public.documents(id) on delete set null,  -- mapped from chunk customMetadata
  source_title    text not null,                           -- snapshot of document name at answer time
  snippet         text,
  page            integer,
  created_at      timestamptz not null default now()
);

-- ---------- LEADS (PDPL consent + dedup) ----------
-- All widget writes go through upsert_lead() (read-before-write with
-- FOR UPDATE, R3). The partial unique indexes below are backstops for
-- rare insert races; on unique_violation the caller retries once.
create table public.leads (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  full_name       text,
  email           text,
  phone           text,
  company         text,
  notes           text,
  status          lead_status not null default 'new',
  source          text not null default 'chat',
  consent_given   boolean not null default false,
  consent_text    text,                                    -- the exact combined prompt the visitor agreed to (verbatim, single-step consent, R1)
  consent_at      timestamptz,
  ip              text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ---------- BILLING (manual in V1; Stripe columns dormant) ----------
create table public.subscriptions (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null unique references public.organizations(id) on delete cascade,
  plan_code              text not null references public.plans(code),
  status                 subscription_status not null default 'trialing',
  started_at             timestamptz not null default now(),
  current_period_end     timestamptz,
  notes                  text,                             -- operator memo: payment link ref, invoice no.
  stripe_customer_id     text,                             -- dormant (ADR-09)
  stripe_subscription_id text,                             -- dormant (ADR-09)
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

create table public.processed_stripe_events (               -- dormant until V2 Stripe (ADR-09)
  id           text primary key,
  type         text,
  processed_at timestamptz not null default now()
);

-- ---------- USAGE (monitoring only in V1) ----------
create table public.usage_counters (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  period_start    date not null,
  period_end      date not null,
  query_count     integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, period_start)
);

-- ---------- LAYERED RATE LIMITING (R1/R3) ----------
-- Generic fixed-window limiter. subject examples:
--   'ref:<end_user_ref uuid>'  — primary friendly per-visitor limit (default 20/hr)
--   'ip:<sha256(ip+salt)>'     — tertiary abuse signal (default 120/hr; UAE CGNAT
--                                means one IP can be many legitimate users)
create table public.rate_limits (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  subject         text not null,
  window_start    timestamptz not null,
  request_count   integer not null default 0,
  created_at      timestamptz not null default now(),
  unique (organization_id, subject, window_start)
);

-- Sharded hourly org ceiling (secondary layer): lock-free under attack
-- (writes spread over N shards, no hot row), bounded (rows only for the
-- current windows), no reaper needed. Quota/abuse guard, NOT billing —
-- a small concurrent overshoot past the ceiling is acceptable by design.
create table public.org_hourly_usage (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  window_start    timestamptz not null,
  shard           smallint not null,
  answer_count    integer not null default 0,
  primary key (organization_id, window_start, shard)
);

-- ---------- AUDIT ----------
create table public.audit_log (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid references public.organizations(id) on delete set null,
  actor_user_id   uuid references public.profiles(id) on delete set null,
  action          text not null,                           -- e.g. org.created, document.deleted, store.deleted, lead.exported
  entity_type     text,
  entity_id       uuid,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

-- ---------- INDEXES ----------
create index idx_members_user            on public.organization_members(user_id);
create index idx_members_org             on public.organization_members(organization_id);
create index idx_documents_org_status    on public.documents(organization_id, status);
create index idx_documents_queued        on public.documents(created_at) where status = 'queued';  -- claim scan
create index idx_convos_org_recent       on public.conversations(organization_id, last_message_at desc);
create index idx_convos_rehydrate        on public.conversations(organization_id, end_user_ref, last_message_at desc)
                                         where end_user_ref is not null;
create index idx_messages_convo          on public.messages(conversation_id, created_at);
create index idx_messages_org            on public.messages(organization_id);
create index idx_citations_message       on public.citations(message_id);
create index idx_leads_org_status        on public.leads(organization_id, status);
create unique index idx_leads_org_email  on public.leads(organization_id, lower(email)) where email is not null;
create unique index idx_leads_org_phone  on public.leads(organization_id, phone) where phone is not null and email is null;  -- phone-only backstop (R2)
create index idx_leads_lookup_phone      on public.leads(organization_id, phone) where phone is not null;                    -- upsert_lead read path
create index idx_audit_org               on public.audit_log(organization_id, created_at desc);

-- ---------- UPDATED_AT TRIGGERS ----------
create trigger trg_plans_updated         before update on public.plans          for each row execute function public.set_updated_at();
create trigger trg_org_updated           before update on public.organizations  for each row execute function public.set_updated_at();
create trigger trg_profiles_updated      before update on public.profiles       for each row execute function public.set_updated_at();
create trigger trg_documents_updated     before update on public.documents      for each row execute function public.set_updated_at();
create trigger trg_convos_updated        before update on public.conversations  for each row execute function public.set_updated_at();
create trigger trg_leads_updated         before update on public.leads          for each row execute function public.set_updated_at();
create trigger trg_subs_updated          before update on public.subscriptions  for each row execute function public.set_updated_at();
create trigger trg_usage_updated         before update on public.usage_counters for each row execute function public.set_updated_at();

-- ---------- NEW-USER PROFILE TRIGGER ----------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data->>'full_name')
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- RLS HELPER ----------
create or replace function public.is_org_member(p_org uuid, p_min_role member_role default 'agent')
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.organization_members m
    where m.organization_id = p_org
      and m.user_id = auth.uid()
      and (
        p_min_role = 'agent'
        or (p_min_role = 'admin' and m.role in ('admin','owner'))
        or (p_min_role = 'owner' and m.role = 'owner')
      )
  );
$$;
grant execute on function public.is_org_member(uuid, member_role) to authenticated;

-- ---------- ATOMIC DOC-CAP ENFORCEMENT (R5 — the law layer) ----------
-- can_upload_document() below is the friendly UX pre-check; THIS
-- trigger is the atomic backstop. The advisory xact lock serializes
-- concurrent inserts per org, closing the READ COMMITTED TOCTOU bypass
-- (50 concurrent uploads can no longer all pass the count check).
create or replace function public.enforce_document_cap()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_cap   integer;
  v_count integer;
begin
  perform pg_advisory_xact_lock(hashtext('salni:doccap:' || new.organization_id::text));

  select p.doc_cap into v_cap
  from public.subscriptions s
  join public.plans p on p.code = s.plan_code
  where s.organization_id = new.organization_id;

  if v_cap is null then
    raise exception 'DOC_CAP_NO_PLAN';                     -- fail closed
  end if;

  select count(*) into v_count
  from public.documents
  where organization_id = new.organization_id
    and status in ('queued','indexing','ready');

  if v_count >= v_cap then
    raise exception 'DOC_CAP_REACHED: plan allows % active documents', v_cap;
  end if;

  return new;
end;
$$;

create trigger trg_enforce_document_cap
  before insert on public.documents
  for each row execute function public.enforce_document_cap();

-- ---------- RPCS & BACKEND FUNCTIONS ----------

-- Atomic tenant onboarding. Clients have NO insert policy on
-- organizations; this RPC is the only creation path. Slug uniqueness
-- violations bubble up for the UI ("slug taken").
create or replace function public.create_organization(p_name text, p_slug text)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_org uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  insert into public.organizations (name, slug)
  values (p_name, p_slug)
  returning id into v_org;

  insert into public.organization_members (organization_id, user_id, role)
  values (v_org, auth.uid(), 'owner');

  insert into public.subscriptions (organization_id, plan_code, status)
  values (v_org, 'starter', 'trialing');

  insert into public.audit_log (organization_id, actor_user_id, action, entity_type, entity_id, metadata)
  values (v_org, auth.uid(), 'org.created', 'organization', v_org,
          jsonb_build_object('name', p_name, 'slug', p_slug));

  return v_org;
end;
$$;
grant execute on function public.create_organization(text, text) to authenticated;

-- Friendly pre-check (UX layer only — the trigger above is the law).
create or replace function public.can_upload_document(p_org uuid)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  v_cap   integer;
  v_count integer;
begin
  select p.doc_cap into v_cap
  from public.subscriptions s
  join public.plans p on p.code = s.plan_code
  where s.organization_id = p_org;

  if v_cap is null then
    return false;
  end if;

  select count(*) into v_count
  from public.documents
  where organization_id = p_org
    and status in ('queued','indexing','ready');

  return v_count < v_cap;
end;
$$;
grant execute on function public.can_upload_document(uuid) to authenticated, service_role;

-- Collision-free queue claiming (R1). Dual-triggered processors
-- (webhook + cron) claim batches safely; SKIP LOCKED guarantees no two
-- workers ever claim the same document.
create or replace function public.claim_queued_documents(p_batch integer default 5)
returns setof public.documents language plpgsql security definer set search_path = public as $$
begin
  return query
  update public.documents d
     set status = 'indexing', updated_at = now()
   where d.id in (
     select id from public.documents
     where status = 'queued'
     order by created_at
     limit p_batch
     for update skip locked
   )
  returning d.*;
end;
$$;
grant execute on function public.claim_queued_documents(integer) to service_role;

-- Indexing status transitions (called by process-documents).
create or replace function public.update_document_status(
  p_document_id uuid,
  p_status doc_status,
  p_file_search_name text default null,
  p_error text default null
)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.documents
     set status                    = p_status,
         file_search_document_name = coalesce(p_file_search_name, file_search_document_name),
         error_message             = p_error,
         indexed_at                = case when p_status = 'ready' then now() else indexed_at end
   where id = p_document_id;
end;
$$;
grant execute on function public.update_document_status(uuid, doc_status, text, text) to service_role;

-- Monthly answer counter (monitoring only in V1; ADR-06).
create or replace function public.record_query_usage(p_org uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_start date := date_trunc('month', now())::date;
  v_end   date := (date_trunc('month', now()) + interval '1 month' - interval '1 day')::date;
  v_count integer;
begin
  insert into public.usage_counters (organization_id, period_start, period_end, query_count)
  values (p_org, v_start, v_end, 1)
  on conflict (organization_id, period_start)
  do update set query_count = public.usage_counters.query_count + 1,
                updated_at  = now()
  returning query_count into v_count;
  return v_count;
end;
$$;
grant execute on function public.record_query_usage(uuid) to service_role;

-- Generic fixed-window (hourly) limiter for 'ref:*' and 'ip:*'
-- subjects. Called BEFORE any Gemini spend; false => throttle reply.
create or replace function public.check_rate_limit(
  p_org uuid,
  p_subject text,
  p_limit integer
)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_window timestamptz := date_trunc('hour', now());
  v_count  integer;
begin
  insert into public.rate_limits (organization_id, subject, window_start, request_count)
  values (p_org, p_subject, v_window, 1)
  on conflict (organization_id, subject, window_start)
  do update set request_count = public.rate_limits.request_count + 1
  returning request_count into v_count;
  return v_count <= p_limit;
end;
$$;
grant execute on function public.check_rate_limit(uuid, text, integer) to service_role;

-- Sharded hourly org ceiling (R3). Sum-then-increment is deliberately
-- soft: tiny concurrent overshoot is acceptable for a quota guard, in
-- exchange for zero hot-row lock contention under a distributed flood.
create or replace function public.check_org_hourly_ceiling(
  p_org uuid,
  p_limit integer default 300,
  p_shards integer default 8
)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_window timestamptz := date_trunc('hour', now());
  v_total  integer;
begin
  select coalesce(sum(answer_count), 0) into v_total
  from public.org_hourly_usage
  where organization_id = p_org and window_start = v_window;

  if v_total >= p_limit then
    return false;
  end if;

  insert into public.org_hourly_usage (organization_id, window_start, shard, answer_count)
  values (p_org, v_window, floor(random() * p_shards)::smallint, 1)
  on conflict (organization_id, window_start, shard)
  do update set answer_count = public.org_hourly_usage.answer_count + 1;

  return true;
end;
$$;
grant execute on function public.check_org_hourly_ceiling(uuid, integer, integer) to service_role;

-- Race-safe shared-store bootstrap (R1). The advisory xact lock
-- serializes the CLAIM decision; the Gemini create call happens outside
-- the transaction (only the single claimant makes it), and a stale
-- sentinel (claimant crashed) is taken over after 2 minutes. Exactly
-- one Gemini store is ever created; no orphans.
create or replace function public.claim_store_bootstrap()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v     jsonb;
  v_now timestamptz := now();
begin
  perform pg_advisory_xact_lock(hashtext('salni:store_bootstrap'));

  select value into v from public.app_config where key = 'shared_file_search_store';

  if v is not null and v ? 'store_name' then
    return jsonb_build_object('status', 'ready', 'store_name', v->>'store_name');
  end if;

  if v is null then
    insert into public.app_config (key, value)
    values ('shared_file_search_store',
            jsonb_build_object('status', 'creating', 'claimed_at', v_now));
    return jsonb_build_object('status', 'claimed');
  end if;

  if (v->>'claimed_at')::timestamptz < v_now - interval '2 minutes' then
    update public.app_config
       set value = jsonb_build_object('status', 'creating', 'claimed_at', v_now),
           updated_at = v_now
     where key = 'shared_file_search_store';
    return jsonb_build_object('status', 'claimed');
  end if;

  return jsonb_build_object('status', 'wait');
end;
$$;
grant execute on function public.claim_store_bootstrap() to service_role;

create or replace function public.finalize_store_bootstrap(p_store_name text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.app_config
     set value = jsonb_build_object('status', 'ready', 'store_name', p_store_name),
         updated_at = now()
   where key = 'shared_file_search_store';
end;
$$;
grant execute on function public.finalize_store_bootstrap(text) to service_role;

-- Read-before-write lead dedup (R3). FOR UPDATE closes the concurrent-
-- message race; matching on email OR phone closes the split-brain case
-- (phone-only Monday, phone+email Tuesday → ONE lead, merged). The
-- partial unique indexes are backstops; on unique_violation the caller
-- retries this function once.
create or replace function public.upsert_lead(
  p_org uuid,
  p_conversation uuid,
  p_full_name text,
  p_email text,
  p_phone text,
  p_company text,
  p_notes text,
  p_consent_text text,
  p_ip text
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id    uuid;
  v_email text := nullif(lower(trim(p_email)), '');
  v_phone text := nullif(trim(p_phone), '');
begin
  if v_email is null and v_phone is null then
    raise exception 'LEAD_NO_CONTACT';
  end if;

  select id into v_id
  from public.leads
  where organization_id = p_org
    and ((v_email is not null and lower(email) = v_email)
      or (v_phone is not null and phone = v_phone))
  order by created_at
  limit 1
  for update;

  if v_id is not null then
    update public.leads
       set full_name       = coalesce(nullif(p_full_name, ''), full_name),
           email           = coalesce(email, v_email),
           phone           = coalesce(phone, v_phone),
           company         = coalesce(nullif(p_company, ''), company),
           notes           = case when nullif(p_notes, '') is null then notes
                                  else coalesce(notes || E'\n', '') || p_notes end,
           conversation_id = coalesce(p_conversation, conversation_id),
           consent_given   = true,
           consent_text    = p_consent_text,
           consent_at      = now(),
           ip              = coalesce(p_ip, ip),
           status          = case when status = 'archived' then 'new' else status end
     where id = v_id;
    return v_id;
  end if;

  insert into public.leads (organization_id, conversation_id, full_name, email, phone,
                            company, notes, consent_given, consent_text, consent_at, ip)
  values (p_org, p_conversation, nullif(p_full_name, ''), v_email, v_phone,
          nullif(p_company, ''), nullif(p_notes, ''), true, p_consent_text, now(), p_ip)
  returning id into v_id;
  return v_id;
end;
$$;
grant execute on function public.upsert_lead(uuid, uuid, text, text, text, text, text, text, text) to service_role;

-- Sweeper (R1 fix): only STALE 'indexing' is requeued/failed — 'queued'
-- documents are NEVER failed for merely waiting in a busy queue. A
-- separate absolute ceiling catches a dead pipeline (queued > 2 hours).
create or replace function public.sweep_stuck_documents(
  p_stale interval default interval '10 minutes',
  p_queue_ceiling interval default interval '2 hours',
  p_max_retries integer default 3
)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_touched integer := 0;
  v_tmp     integer;
begin
  -- Stale mid-index, retries exhausted -> fail loudly
  update public.documents
     set status = 'failed',
         error_message = 'Indexing timed out after maximum retries'
   where status = 'indexing'
     and updated_at < now() - p_stale
     and retry_count >= p_max_retries;
  get diagnostics v_tmp = row_count;
  v_touched := v_touched + v_tmp;

  -- Stale mid-index, retries left -> requeue
  update public.documents
     set status = 'queued',
         retry_count = retry_count + 1,
         error_message = 'Auto-requeued by sweeper'
   where status = 'indexing'
     and updated_at < now() - p_stale
     and retry_count < p_max_retries;
  get diagnostics v_tmp = row_count;
  v_touched := v_touched + v_tmp;

  -- Queued far beyond any healthy backlog -> pipeline is down; fail visibly
  update public.documents
     set status = 'failed',
         error_message = 'Queued too long — indexing pipeline may be down'
   where status = 'queued'
     and updated_at < now() - p_queue_ceiling;
  get diagnostics v_tmp = row_count;
  v_touched := v_touched + v_tmp;

  return v_touched;
end;
$$;
grant execute on function public.sweep_stuck_documents(interval, interval, integer) to service_role;

-- ---------- ENABLE RLS (every table, no exceptions) ----------
alter table public.plans                   enable row level security;
alter table public.app_config              enable row level security;
alter table public.organizations           enable row level security;
alter table public.profiles                enable row level security;
alter table public.organization_members    enable row level security;
alter table public.documents               enable row level security;
alter table public.conversations           enable row level security;
alter table public.messages                enable row level security;
alter table public.citations               enable row level security;
alter table public.leads                   enable row level security;
alter table public.subscriptions           enable row level security;
alter table public.processed_stripe_events enable row level security;
alter table public.usage_counters          enable row level security;
alter table public.rate_limits             enable row level security;
alter table public.org_hourly_usage        enable row level security;
alter table public.audit_log               enable row level security;

-- ---------- RLS POLICIES ----------
-- plans: readable reference data for signed-in users
create policy plans_read on public.plans for select to authenticated using (true);

-- app_config: DELIBERATELY NO POLICIES — service_role only. Builders
-- must NOT generate fallback read policies for this table.

-- profiles: self only
create policy profiles_self_select on public.profiles for select using (id = auth.uid());
create policy profiles_self_update on public.profiles for update using (id = auth.uid());

-- organizations: members read; admins update. Intentionally NO insert
-- policy (create_organization RPC only) and NO delete policy
-- (offboarding via the delete Edge Function: Gemini first, storage
-- second, rows last). (ADR-08)
create policy org_member_select on public.organizations for select using (public.is_org_member(id));
create policy org_admin_update  on public.organizations for update using (public.is_org_member(id, 'admin'));

-- membership: members see co-members; admins manage
create policy members_select on public.organization_members for select using (public.is_org_member(organization_id));
create policy members_manage on public.organization_members for all
  using (public.is_org_member(organization_id, 'admin'))
  with check (public.is_org_member(organization_id, 'admin'));

-- documents: members select/insert/update. NO delete policy — deletion
-- is API-enforced through the delete Edge Function. (ADR-08)
create policy documents_member_select on public.documents for select using (public.is_org_member(organization_id));
create policy documents_member_insert on public.documents for insert with check (public.is_org_member(organization_id));
create policy documents_member_update on public.documents for update using (public.is_org_member(organization_id));

-- chat data: members read; ALL chat writes happen in Edge Functions via
-- service_role (dashboard and widget alike) for one consistent path.
create policy convos_member_select    on public.conversations for select using (public.is_org_member(organization_id));
create policy messages_member_select  on public.messages      for select using (public.is_org_member(organization_id));
create policy citations_member_select on public.citations     for select using (public.is_org_member(organization_id));

-- leads: members read + update (status, notes). NO client insert (the
-- widget writes via upsert_lead under service_role) and NO client
-- delete (erasure via Edge Function, audited).
create policy leads_member_select on public.leads for select using (public.is_org_member(organization_id));
create policy leads_member_update on public.leads for update using (public.is_org_member(organization_id));

-- subscriptions: members read; writes are operator/service actions.
create policy subs_member_select on public.subscriptions for select using (public.is_org_member(organization_id));

-- usage_counters, rate_limits, org_hourly_usage, audit_log,
-- processed_stripe_events: DELIBERATELY NO client policies ->
-- service_role only (bypasses RLS). Builders must NOT stub policies.

-- ============================================================
-- Public widget traffic (anonymous) has NO direct table access and NO
-- Realtime subscriptions (anonymous users have no RLS grants; a widget
-- Realtime subscription would silently fail). Every widget read/write
-- goes through service-role Edge Functions. Realtime is used ONLY in
-- the authenticated dashboard.
-- ============================================================

-- ---------- TABLE-LEVEL GRANTS (V3 — required; see header) ----------
-- Layer BELOW RLS: without these, Postgres returns 42501 "permission
-- denied for table" before RLS is even evaluated. RLS (and the
-- absence of policies) still fully controls WHICH rows each role can
-- touch — e.g. app_config is granted to service_role here but has
-- zero policies, so authenticated/anon remain fully locked out.
grant usage on schema public to authenticated, anon, service_role;

-- Client-facing tables (RLS policies above narrow the rows; tables
-- with no insert/delete policy still deny those actions despite the
-- grant — grants permit, policies decide):
grant select, insert, update on
  public.organizations,
  public.organization_members,
  public.profiles,
  public.documents,
  public.conversations,
  public.messages,
  public.citations,
  public.leads,
  public.subscriptions,
  public.plans
to authenticated;

-- Backend/worker role: full table access on every table. service_role
-- bypasses RLS but NOT grants. Deletion ordering (Gemini → Storage →
-- rows) is enforced in the delete server function, not here.
grant select, insert, update, delete on
  public.plans,
  public.app_config,
  public.organizations,
  public.profiles,
  public.organization_members,
  public.documents,
  public.conversations,
  public.messages,
  public.citations,
  public.leads,
  public.subscriptions,
  public.processed_stripe_events,
  public.usage_counters,
  public.rate_limits,
  public.org_hourly_usage,
  public.audit_log
to service_role;

-- Storage schema (signed upload URLs + object deletion run as
-- service_role; absence of these caused live failures):
grant usage on schema storage to service_role;
grant all on storage.objects, storage.buckets to service_role;

-- No sequences exist (all keys are gen_random_uuid()); no sequence
-- grants required. ANY NEW TABLE added later MUST be appended to the
-- service_role grant list above (and to authenticated if client-read).

-- ---------- CRON SCHEDULES (run once after enabling pg_cron + pg_net) ----------
-- SECURITY (R2): the cron ping carries CRON_WEBHOOK_SECRET — a
-- dedicated low-privilege shared secret that process-documents
-- validates. The service_role key is NEVER placed in pg_net requests
-- (pg_net logs headers into its internal queue tables; putting the
-- master key there would expose it inside the database).
--
-- Job 1: recover stuck documents.
-- select cron.schedule('sweep-stuck-documents', '*/5 * * * *',
--   $$select public.sweep_stuck_documents();$$);
--
-- Job 2: drive the queued-document processor (webhook = fast path,
-- this ping = guarantee). Store CRON_WEBHOOK_SECRET in Supabase Vault.
-- select cron.schedule('process-queued-documents', '*/5 * * * *',
--   $$select net.http_post(
--       url     := 'https://<project-ref>.supabase.co/functions/v1/process-documents',
--       headers := jsonb_build_object('x-cron-secret',
--                    (select decrypted_secret from vault.decrypted_secrets
--                      where name = 'cron_webhook_secret'))
--     );$$);

-- ---------- STORAGE (R4/R5) ----------
-- Create a PRIVATE bucket 'documents' with NATIVE constraints:
--   fileSizeLimit: 52428800 (50 MB — matches the size_bytes CHECK)
--   allowedMimeTypes: application/pdf, text/plain, text/markdown,
--     text/csv, application/msword,
--     application/vnd.openxmlformats-officedocument.wordprocessingml.document,
--     application/vnd.ms-excel,
--     application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,
--     application/vnd.ms-powerpoint,
--     application/vnd.openxmlformats-officedocument.presentationml.presentation
-- Upload flow is ROW-FIRST: the documents row is inserted (cap trigger
-- fires) and the file is then uploaded to <org_id>/<document_id>/<file_name>.
-- Storage policies: members may write only under their org's prefix;
-- processing reads happen via service_role. MIME allow-listing is the
-- secondary layer; the size limit is the primary defense, and the
-- processor re-checks object size before download (no OOM on lies).
--
-- ---------- GEMINI FILE SEARCH OPERATIONAL FACTS (V3, app-level) ----------
--  * Deleting an indexed document requires force:true, else 400
--    FAILED_PRECONDITION "Cannot delete non-empty Document".
--  * fileSearchStores.documents.list page_size must be 1–20.
--  * New uploads are chunked at maxTokensPerChunk 200 / overlap 20
--    (set in process-documents). Chunking applies at INGESTION only —
--    re-upload a document to re-chunk it.
--  * operations.get on an upload can complete WITHOUT response.name;
--    documents.file_search_document_name may then be null and needs
--    the app-level backfill (list store docs, match on
--    customMetadata.document_id) before deletion can target it.
--  * gemini-2.5-flash streams thought parts by default; the query
--    routes set thinkingConfig.includeThoughts=false AND filter any
--    part with thought=true (belt and suspenders vs. duplicated text).
