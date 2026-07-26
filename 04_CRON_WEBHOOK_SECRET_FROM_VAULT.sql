-- Rewrite cron job 2 (process-documents worker) to read CRON_WEBHOOK_SECRET
-- from Supabase Vault at call time, instead of inlining the value in the
-- job command (where it leaks into cron.job_run_details on every run).
--
-- PREREQUISITE — run once, out of band, BEFORE applying this migration:
--
--   select vault.create_secret(
--     '<new-secret-value>',
--     'cron_webhook_secret',
--     'Bearer secret for /api/public/process-documents cron job'
--   );
--
-- (If the vault entry already exists, use vault.update_secret to rotate it.)
--
-- This migration does NOT create a second job. It unschedules the existing
-- job by name and reschedules it under the same name with a Vault lookup.

do $$
declare
  v_secret text;
begin
  select decrypted_secret
    into v_secret
  from vault.decrypted_secrets
  where name = 'cron_webhook_secret';

  if v_secret is null then
    raise exception 'vault secret "cron_webhook_secret" not found. Run vault.create_secret first.';
  end if;
end
$$;

-- Drop the old job (name-based; safe if it doesn't exist).
select cron.unschedule('process-documents-worker')
where exists (select 1 from cron.job where jobname = 'process-documents-worker');

-- Reschedule under the same name. The secret is looked up from Vault on
-- every fire, so the job command stored in cron.job (and any run_details
-- rows) contains only the SQL, never the secret value.
select
  cron.schedule(
    'process-documents-worker',
    '* * * * *',
    $cron$
    select net.http_post(
      url := 'https://project--630a3e42-fc47-4ca6-8422-2565286ac163.lovable.app/api/public/process-documents',
      headers := jsonb_build_object(
        'content-type', 'application/json',
        'x-cron-secret',
          (select decrypted_secret
             from vault.decrypted_secrets
             where name = 'cron_webhook_secret')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 30000
    );
    $cron$
  );

-- After applying: verify with
--   select jobname, schedule, command from cron.job where jobname = 'process-documents-worker';
-- The command column must reference vault.decrypted_secrets and must NOT
-- contain the raw secret value.