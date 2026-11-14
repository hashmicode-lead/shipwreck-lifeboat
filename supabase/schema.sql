-- Lifeboat game database for Supabase.
-- Run this whole file once in Supabase → SQL Editor → New query → Run. Running it again is safe (it updates the functions).
-- Each game action is one function, so it runs as one transaction: when 100 students act at once, nobody's change is lost.
-- Row locks always go game row first, then team row, so two actions can't deadlock.
-- Only the server (service_role / secret key) can use these; the public anon key gets nothing.

create table if not exists lb_game (
  id int primary key default 1 check (id = 1),     -- exactly one game
  phase text not null default 'lobby',
  started_at timestamptz,
  ends_at timestamptz,                              -- null when the phase has no timer
  roster jsonb                                      -- class list {"1": ["Asha", …], …} or null; survives a game reset
);
insert into lb_game (id) values (1) on conflict do nothing;

create table if not exists lb_team (
  team int primary key,
  ord jsonb,                                        -- the shared discussion order
  v int not null default 0,                         -- bumps on every change; approvals are for one version
  approved text[] not null default '{}',            -- player ids who approved version v
  grp jsonb,                                        -- the locked final order
  last_by text                                      -- name of whoever changed the order last
);

create table if not exists lb_player (
  id text primary key,
  name text not null,
  team int not null references lb_team (team) on delete cascade,
  list jsonb,                                       -- Round 1 order
  changes int not null default 0,                   -- times they changed the team order
  undid int not null default 0,                     -- …of which after teammates had approved
  joined_at timestamptz not null default clock_timestamp()
);
create index if not exists lb_player_team on lb_player (team);
create unique index if not exists lb_player_name on lb_player (team, lower(name));

alter table lb_game enable row level security;      -- no policies: the public API keys can't touch the tables
alter table lb_team enable row level security;
alter table lb_player enable row level security;

/* ---------- rules ---------- */
create or replace function lb_chars() returns jsonb language sql immutable set search_path = public as $$
  select '["Doctor","Cook","Priest","Engineer","Teacher","Soldier","Farmer","Journalist","Child","Elderly Scientist"]'::jsonb $$;
create or replace function lb_next(p text) returns text language sql immutable set search_path = public as $$
  select case p when 'lobby' then 'story' when 'story' then 'r1' when 'r1' then 'discuss' when 'discuss' then 'results' end $$;
create or replace function lb_dur(p text) returns int language sql immutable set search_path = public as $$
  select case p when 'story' then 14 when 'r1' then 180 when 'discuss' then 900 else 0 end $$;
create or replace function lb_ms(t timestamptz) returns bigint language sql stable set search_path = public as $$
  select coalesce((extract(epoch from t) * 1000)::bigint, 0) $$;
create or replace function lb_err(msg text) returns jsonb language sql immutable set search_path = public as $$
  select jsonb_build_object('error', msg) $$;

-- A list is valid only if it is exactly the 10 passengers, each once.
create or replace function lb_valid(l jsonb) returns boolean language plpgsql immutable set search_path = public as $$
begin
  if l is null or jsonb_typeof(l) <> 'array' or jsonb_array_length(l) <> 10 then return false; end if;
  if exists (select 1 from jsonb_array_elements(l) e where jsonb_typeof(e) <> 'string') then return false; end if;
  return (select array_agg(x order by x) from jsonb_array_elements_text(l) x)
       = (select array_agg(x order by x) from jsonb_array_elements_text(lb_chars()) x);
end $$;

create or replace function lb_pos(l jsonb, c text) returns int language sql immutable set search_path = public as $$
  select (o - 1)::int from jsonb_array_elements_text(l) with ordinality t (x, o) where x = c $$;
-- |your seat − team seat| per passenger, and the sum (marks = 90 − sum).
create or replace function lb_diffs(mine jsonb, grp jsonb) returns jsonb language sql immutable set search_path = public as $$
  select jsonb_agg(abs(lb_pos(mine, c) - lb_pos(grp, c)) order by ci) from jsonb_array_elements_text(lb_chars()) with ordinality ch (c, ci) $$;
create or replace function lb_diff(mine jsonb, grp jsonb) returns int language sql immutable set search_path = public as $$
  select sum(abs(lb_pos(mine, c) - lb_pos(grp, c)))::int from jsonb_array_elements_text(lb_chars()) c $$;

-- Discussion starts from the team's average Round 1 order, so nobody's list is favoured.
create or replace function lb_starting_order(p_team int) returns jsonb language sql stable set search_path = public as $$
  select coalesce((
    select jsonb_agg(c order by m, ci) from (
      select ch.c, ch.ci, avg(lb_pos(p.list, ch.c)) m
      from jsonb_array_elements_text(lb_chars()) with ordinality ch (c, ci)
      cross join lb_player p where p.team = p_team and p.list is not null
      group by ch.c, ch.ci) s), lb_chars()) $$;

create or replace function lb_all_approved(p_team int) returns boolean language sql stable set search_path = public as $$
  select not exists (select 1 from lb_player p join lb_team t on t.team = p.team where p.team = p_team and not (p.id = any (t.approved))) $$;

-- Call with the game row locked.
create or replace function lb_set_phase(p text) returns void language plpgsql set search_path = public as $$
begin
  if p is null then return; end if;
  if p = 'discuss' then update lb_team set ord = lb_starting_order(team), v = 1, approved = '{}', grp = null, last_by = null where true; end if;
  if p = 'results' then update lb_team set grp = coalesce(ord, lb_starting_order(team)) where grp is null; end if;   -- time up: the shared order stands
  update lb_game set phase = p, started_at = now(),
    ends_at = case when lb_dur(p) > 0 then now() + make_interval(secs => lb_dur(p)) end where id = 1;
end $$;

-- Timed phases advance on their own: whichever request arrives first after the timer ends moves the game on.
create or replace function lb_tick() returns void language plpgsql set search_path = public as $$
declare g lb_game;
begin
  if not exists (select 1 from lb_game where id = 1 and ends_at <= now()) then return; end if;
  select * into g from lb_game where id = 1 for update;
  while g.ends_at is not null and g.ends_at <= now() loop
    perform lb_set_phase(lb_next(g.phase));
    select * into g from lb_game where id = 1;
  end loop;
end $$;

-- Team summary. Only the host gets everyone's marks and order-change flags.
create or replace function lb_team_out(p_team int, p_host boolean) returns jsonb language plpgsql stable set search_path = public as $$
declare t lb_team; scores boolean; mem jsonb; av numeric;
begin
  select * into t from lb_team where team = p_team;
  if not found then return null; end if;
  scores := p_host and (select phase from lb_game where id = 1) = 'results' and t.grp is not null;
  select coalesce(jsonb_agg(
      jsonb_build_object('name', p.name, 'done', p.list is not null, 'approved', p.id = any (t.approved))
      || case when p_host then jsonb_build_object('changes', p.changes, 'undid', p.undid) else '{}' end
      || case when scores then jsonb_build_object(
           'marks', case when p.list is not null then 90 - lb_diff(p.list, t.grp) end,
           'difference', case when p.list is not null then lb_diff(p.list, t.grp) end) else '{}' end
      order by p.joined_at), '[]') into mem
    from lb_player p where p.team = p_team;
  if scores then select round(avg(90 - lb_diff(list, t.grp)), 1) into av from lb_player where team = p_team and list is not null; end if;
  return jsonb_build_object('team', t.team, 'members', mem, 'order', t.ord, 'v', t.v, 'approvals', cardinality(t.approved),
    'group', t.grp, 'lastBy', t.last_by, 'avg', av);
end $$;

/* ---------- API (called by the Vercel function) ---------- */
create or replace function lb_state(p_id text) returns jsonb language plpgsql set search_path = public as $$
declare g lb_game; p lb_player; t lb_team; res jsonb;
begin
  perform lb_tick();
  select * into g from lb_game where id = 1;
  select * into p from lb_player where id = p_id;
  if not found then return jsonb_build_object('error', 'unknown', 'phase', g.phase, 'chars', lb_chars()); end if;
  select * into t from lb_team where team = p.team;
  if g.phase = 'results' and p.list is not null and t.grp is not null then
    res := jsonb_build_object('diffs', lb_diffs(p.list, t.grp), 'difference', lb_diff(p.list, t.grp), 'marks', 90 - lb_diff(p.list, t.grp), 'max', 90);
  end if;
  return jsonb_build_object('phase', g.phase, 'endsAt', lb_ms(g.ends_at), 'startedAt', lb_ms(g.started_at), 'now', lb_ms(clock_timestamp()),
    'chars', lb_chars(), 'me', jsonb_build_object('name', p.name, 'team', p.team, 'list', p.list, 'approved', p.id = any (t.approved)),
    'team', lb_team_out(p.team, false), 'result', res);
end $$;

-- Join screen: the class list with names already taken, or null when students type their own name.
create or replace function lb_roster() returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object('teams', case when g.roster is null then null else (
    select jsonb_agg(jsonb_build_object('team', k::int, 'names', (
      select jsonb_agg(jsonb_build_object('name', x, 'taken', exists (select 1 from lb_player p where p.team = k::int and lower(p.name) = lower(x))) order by o)
      from jsonb_array_elements_text(g.roster -> k) with ordinality r (x, o))) order by k::int)
    from jsonb_object_keys(g.roster) k) end)
  from lb_game g where g.id = 1 $$;

create or replace function lb_join(p_id text, p_name text, p_team int) returns jsonb language plpgsql set search_path = public as $$
declare g lb_game; t lb_team; nm text := p_name; listed text;
begin
  perform lb_tick();
  select * into g from lb_game where id = 1;
  if p_team is null or p_team < 1 or p_team > 20 then return lb_err('Pick a team from 1 to 20.'); end if;
  if g.roster is not null then
    if not (g.roster ? p_team::text) then return lb_err(format('Team %s isn''t on the class list.', p_team)); end if;
    select x into listed from jsonb_array_elements_text(g.roster -> p_team::text) x where lower(x) = lower(p_name) limit 1;
    if listed is null then return lb_err(format('Pick your name from the Team %s list.', p_team)); end if;
    nm := listed;
  end if;
  insert into lb_team (team) values (p_team) on conflict do nothing;
  select * into t from lb_team where team = p_team for update;
  if (select count(*) from lb_player where team = p_team) >= 10 then return lb_err(format('Team %s is full.', p_team)); end if;
  if exists (select 1 from lb_player where team = p_team and lower(name) = lower(nm)) then
    return lb_err(case when g.roster is not null then format('%s has already joined. If that is not you, ask the host to free your name.', nm)
                       else format('Someone in Team %s already uses that name. Add an initial.', p_team) end);
  end if;
  insert into lb_player (id, name, team) values (p_id, nm, p_team);
  if g.phase = 'discuss' and t.ord is null then
    update lb_team set ord = lb_starting_order(p_team), v = 1, approved = '{}' where team = p_team;
  else
    update lb_team set approved = '{}' where team = p_team;   -- a new member hasn't approved yet
  end if;
  return jsonb_build_object('id', p_id);
end $$;

create or replace function lb_rank(p_id text, p_list jsonb) returns jsonb language plpgsql set search_path = public as $$
begin
  perform lb_tick();
  if not exists (select 1 from lb_player p, lb_game g where p.id = p_id and g.id = 1 and g.phase = 'r1' and p.list is null) then return lb_err('Not accepted now.'); end if;
  if not lb_valid(p_list) then return lb_err('Seat all 10 passengers.'); end if;
  update lb_player set list = p_list where id = p_id and list is null;
  return '{"ok": true}';
end $$;

-- Discussion: anyone on the team can rearrange the shared order. Any change clears every approval.
create or replace function lb_order(p_id text, p_list jsonb) returns jsonb language plpgsql set search_path = public as $$
declare p lb_player; t lb_team;
begin
  perform lb_tick();
  select * into p from lb_player where id = p_id;
  if not found then return lb_err('The team order is locked.'); end if;
  select * into t from lb_team where team = p.team for update;
  if (select phase from lb_game where id = 1) <> 'discuss' or t.ord is null or t.grp is not null then return lb_err('The team order is locked.'); end if;
  if not lb_valid(p_list) then return lb_err('Keep all 10 passengers in the lifeboat.'); end if;
  if p_list <> t.ord then
    update lb_player set changes = changes + 1,
      undid = undid + case when exists (select 1 from unnest(t.approved) a where a <> p_id) then 1 else 0 end   -- flagged for the host
      where id = p_id;
    update lb_team set ord = p_list, v = v + 1, approved = '{}', last_by = p.name where team = p.team returning v into t.v;
  end if;
  return jsonb_build_object('ok', true, 'v', t.v);
end $$;

-- Approve the exact version you are looking at. When every member approves, the order locks.
create or replace function lb_approve(p_id text, p_v int, p_on boolean) returns jsonb language plpgsql set search_path = public as $$
declare p lb_player; t lb_team;
begin
  perform lb_tick();
  select * into p from lb_player where id = p_id;
  if not found then return lb_err('The team order is locked.'); end if;
  select * into t from lb_team where team = p.team for update;
  if (select phase from lb_game where id = 1) <> 'discuss' or t.ord is null or t.grp is not null then return lb_err('The team order is locked.'); end if;
  if p_v is distinct from t.v then return lb_err('The order just changed. Check it again before approving.'); end if;
  if p_on then
    update lb_team set approved = case when p_id = any (approved) then approved else approved || p_id end where team = p.team;
  else
    update lb_team set approved = array_remove(approved, p_id) where team = p.team;
  end if;
  if lb_all_approved(p.team) then update lb_team set grp = ord where team = p.team; end if;
  return '{"ok": true}';
end $$;

create or replace function lb_host_get() returns jsonb language plpgsql set search_path = public as $$
declare g lb_game;
begin
  perform lb_tick();
  select * into g from lb_game where id = 1;
  return jsonb_build_object('phase', g.phase, 'endsAt', lb_ms(g.ends_at), 'startedAt', lb_ms(g.started_at), 'now', lb_ms(clock_timestamp()),
    'players', (select count(*) from lb_player), 'maxMarks', 90, 'roster', g.roster,
    'teams', coalesce((select jsonb_agg(lb_team_out(team, true) order by team) from lb_team), '[]'));
end $$;

create or replace function lb_host(p_action text, p_roster jsonb, p_team int, p_name text) returns jsonb language plpgsql set search_path = public as $$
declare g lb_game; pl lb_player;
begin
  perform lb_tick();
  select * into g from lb_game where id = 1 for update;
  if p_action = 'next' then
    perform lb_set_phase(lb_next(g.phase));
  elsif p_action = 'more' then
    update lb_game set ends_at = ends_at + interval '60 seconds' where id = 1 and ends_at is not null;
  elsif p_action = 'reset' then   -- the class list stays
    delete from lb_player where true;
    delete from lb_team where true;
    update lb_game set phase = 'lobby', started_at = null, ends_at = null where id = 1;
  elsif p_action = 'roster' then
    if g.phase <> 'lobby' then return lb_err('Change the class list in the lobby, before the game starts.'); end if;
    update lb_game set roster = p_roster where id = 1;
  elsif p_action = 'kick' then   -- frees a seat and a name, e.g. when a student's phone dies and they rejoin on another
    perform 1 from lb_team where team = p_team for update;
    select * into pl from lb_player where team = p_team and name = p_name;
    if not found then return lb_err('Player not found.'); end if;
    delete from lb_player where id = pl.id;
    update lb_team set approved = array_remove(approved, pl.id) where team = p_team;
    if not exists (select 1 from lb_player where team = p_team) then
      delete from lb_team where team = p_team;
    elsif g.phase = 'discuss' and lb_all_approved(p_team) then
      update lb_team set grp = ord where team = p_team and ord is not null and grp is null;
    end if;
  else
    return lb_err('Unknown action.');
  end if;
  return '{"ok": true}';
end $$;

/* ---------- access: server only ---------- */
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'lb\_%' loop
    execute format('revoke all on function %s from public', f.sig);
    begin
      execute format('revoke all on function %s from anon, authenticated', f.sig);
      execute format('grant execute on function %s to service_role', f.sig);
    exception when undefined_object then null;   -- outside Supabase (local tests) these roles don't exist
    end;
  end loop;
  begin
    revoke all on lb_game, lb_team, lb_player from anon, authenticated;
    grant all on lb_game, lb_team, lb_player to service_role;
  exception when undefined_object then null;
  end;
end $$;

notify pgrst, 'reload schema';
