-- Run this once in Supabase: SQL Editor > New query > paste > Run.

-- All app data lives here: games, tips (picks and names), players (team assignments), meta.
create table if not exists public.docs (
  collection text not null,
  id         text not null,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (collection, id)
);

-- Who runs the comp
create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade
);

-- Display names, created automatically when someone first signs in
create table if not exists public.profiles (
  id   uuid primary key references auth.users(id) on delete cascade,
  name text
);

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

alter table public.docs     enable row level security;
alter table public.admins   enable row level security;
alter table public.profiles enable row level security;

-- Anyone signed in can see everything
create policy "signed-in can read docs"     on public.docs     for select to authenticated using (true);
create policy "signed-in can read admins"   on public.admins   for select to authenticated using (true);
create policy "signed-in can read profiles" on public.profiles for select to authenticated using (true);

-- Admins can write anything (games, results, team assignments, comp name)
create policy "admins write docs" on public.docs for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Each player can write only their own tips row (their pick and display name)
create policy "players insert own tips" on public.docs for insert to authenticated
  with check (collection = 'tips' and id = auth.uid()::text);
create policy "players update own tips" on public.docs for update to authenticated
  using (collection = 'tips' and id = auth.uid()::text)
  with check (collection = 'tips' and id = auth.uid()::text);

create policy "players update own profile" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- New sign-ups get a profile, named from the sign-in form or their email
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name)
  values (new.id, coalesce(nullif(new.raw_user_meta_data->>'name', ''), split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Live updates in the browser
alter publication supabase_realtime add table public.docs;

insert into public.docs (collection, id, data)
values ('meta', 'settings', '{"name": "NFL Tipping 2026"}')
on conflict do nothing;
