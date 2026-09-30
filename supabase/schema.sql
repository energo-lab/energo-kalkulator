-- ENERGO GROUP – Kalkulátor FVE + Baterie
-- Sdílený archiv nabídek (Supabase / Postgres)
-- Spustit v Supabase: SQL Editor → New query → vložit → Run. Skript je idempotentní.

create table if not exists public.offers (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  customer         text,
  data             jsonb not null,                              -- kompletní vstupy kalkulačky (objekt I)
  created_by       uuid default auth.uid() references auth.users(id) on delete set null,
  created_by_email text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists offers_created_at_idx on public.offers (created_at desc);

alter table public.offers enable row level security;

-- Sdílený týmový archiv: každý přihlášený uživatel vidí a spravuje všechny nabídky.
drop policy if exists "offers_select_authenticated" on public.offers;
drop policy if exists "offers_insert_authenticated" on public.offers;
drop policy if exists "offers_update_authenticated" on public.offers;
drop policy if exists "offers_delete_authenticated" on public.offers;

create policy "offers_select_authenticated" on public.offers
  for select to authenticated using (true);
create policy "offers_insert_authenticated" on public.offers
  for insert to authenticated with check (auth.uid() = created_by);
create policy "offers_update_authenticated" on public.offers
  for update to authenticated using (true) with check (true);
create policy "offers_delete_authenticated" on public.offers
  for delete to authenticated using (true);

-- Automatická aktualizace updated_at
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists offers_set_updated_at on public.offers;
create trigger offers_set_updated_at
  before update on public.offers
  for each row execute function public.set_updated_at();
