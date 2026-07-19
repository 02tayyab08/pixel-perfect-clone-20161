-- Incremental apply for Phase 1 document probes (Option A side state).
-- Source of truth remains 02_FINAL_SCHEMA_V3.sql — run this on live DBs that
-- already applied V3 before document_probes existed.
-- Operator applies; app code must not invent these objects.

create type public.probe_class as enum (
  'ok', 'warn', 'bad', 'skipped', 'inconclusive'
);
create type public.probe_confidence as enum ('high', 'low');

create table public.document_probes (
  id                  uuid primary key default gen_random_uuid(),
  document_id         uuid not null references public.documents(id) on delete cascade,
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  probe_class         public.probe_class not null,
  probe_confidence    public.probe_confidence not null default 'high',
  success_rate        numeric(4,3),
  questions_total     integer not null default 0
    check (questions_total >= 0),
  questions_grounded  integer not null default 0
    check (questions_grounded >= 0),
  questions           jsonb not null default '[]'::jsonb,
  results             jsonb not null default '[]'::jsonb,
  extract_chars       integer,
  model               text,
  cost_usd            numeric(12,6),
  created_at          timestamptz not null default now()
);

create index idx_document_probes_doc_created
  on public.document_probes(document_id, created_at desc);
create index idx_document_probes_org_class
  on public.document_probes(organization_id, probe_class);

create or replace function public.claim_documents_for_probe(p_batch integer default 5)
returns setof public.documents
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.documents d
     set updated_at = now()
   where d.id in (
     select d2.id
       from public.documents d2
      where d2.status = 'ready'
        and d2.file_search_document_name is not null
        and not exists (
          select 1 from public.document_probes p where p.document_id = d2.id
        )
      order by d2.indexed_at nulls first, d2.created_at
      for update of d2 skip locked
      limit greatest(coalesce(p_batch, 5), 1)
   )
  returning d.*;
end;
$$;

grant execute on function public.claim_documents_for_probe(integer) to service_role;

alter table public.document_probes enable row level security;

create policy document_probes_member_select on public.document_probes
  for select using (public.is_org_member(organization_id));

grant select on public.document_probes to authenticated;
grant select, insert, update, delete on public.document_probes to service_role;
