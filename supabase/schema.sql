-- Industropolis Batang Futsal League: skema database Supabase.
-- Cara pakai: Supabase Dashboard -> SQL Editor -> New query -> tempel seluruh isi file ini -> Run.
-- Aman dijalankan ulang (memakai IF NOT EXISTS / CREATE OR REPLACE).
--
-- Rancangan: satu tabel per koleksi lama di Firestore (teams, players, matches, events, settings).
-- Tiap baris = satu dokumen: id (teks) + data (JSON). Jadi bentuk datanya sama persis dengan Firestore
-- dan kode website tidak perlu tahu perbedaannya. Logo tim (gambar base64 besar) disimpan di tabel
-- terpisah team_logos supaya pengunjung tidak mengunduhnya terus-menerus (hemat kuota bandwidth gratis).

-- ---------- Tabel ----------
create table if not exists public.teams    (id text primary key, data jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now());
create table if not exists public.players  (id text primary key, data jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now());
create table if not exists public.matches  (id text primary key, data jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now());
create table if not exists public.events   (id text primary key, data jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now());
create table if not exists public.settings (id text primary key, data jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now());
create table if not exists public.team_logos (id text primary key, logo text not null, hash text not null, updated_at timestamptz not null default now());
-- Daftar akun admin (diisi manual, lihat bagian paling bawah file ini).
create table if not exists public.admins (uid uuid primary key);

create index if not exists players_team_idx on public.players ((data->>'teamId'));
create index if not exists events_match_idx on public.events ((data->>'matchId'));

-- Hak akses dasar (aturan RLS di bawah yang menentukan siapa boleh apa)
grant usage on schema public to anon, authenticated;
grant select on public.teams, public.players, public.matches, public.events, public.settings, public.team_logos to anon, authenticated;
grant insert, update, delete on public.teams, public.players, public.matches, public.events, public.settings, public.team_logos to authenticated;

-- updated_at otomatis
create or replace function public.touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
do $$
declare t text;
begin
  foreach t in array array['teams','players','matches','events','settings','team_logos'] loop
    execute format('drop trigger if exists touch on public.%I', t);
    execute format('create trigger touch before update on public.%I for each row execute function public.touch_updated_at()', t);
  end loop;
end $$;

-- ---------- Keamanan (pengganti firestore.rules) ----------
-- Siapa pun boleh MEMBACA. Hanya akun di tabel admins yang boleh MENULIS.
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where uid = auth.uid())
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;

alter table public.admins enable row level security;  -- tanpa policy = tertutup untuk semua kecuali lewat SQL Editor

do $$
declare t text;
begin
  foreach t in array array['teams','players','matches','events','settings','team_logos'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "baca publik" on public.%I', t);
    execute format('drop policy if exists "admin tulis" on public.%I', t);
    execute format('create policy "baca publik" on public.%I for select to anon, authenticated using (true)', t);
    execute format('create policy "admin tulis" on public.%I for all to authenticated using (public.is_admin()) with check (public.is_admin())', t);
  end loop;
end $$;

-- ---------- Penggabungan JSON (meniru setDoc merge:true di Firestore: objek digabung sampai ke dalam) ----------
create or replace function public.jsonb_deep_merge(a jsonb, b jsonb) returns jsonb
language sql immutable as $$
  select case
    when jsonb_typeof(a) = 'object' and jsonb_typeof(b) = 'object' then
      coalesce((
        select jsonb_object_agg(k,
          case when a ? k and b ? k then public.jsonb_deep_merge(a -> k, b -> k)
               when b ? k then b -> k
               else a -> k end)
        from (select jsonb_object_keys(a) as k union select jsonb_object_keys(b)) s
      ), '{}'::jsonb)
    else b
  end
$$;

-- ---------- Tulis banyak dokumen sekaligus dalam SATU transaksi (pengganti writeBatch) ----------
-- ops: [{ "t": "matches", "id": "abc", "op": "set|merge|update|delete", "data": {...}, "del": ["namaField"] }, ...]
--   set    = ganti seluruh dokumen          merge  = gabung (objek digabung sampai ke dalam)
--   update = ubah field tingkat atas (dokumen harus sudah ada; "del" menghapus field)
--   delete = hapus dokumen
-- Bila satu operasi gagal, semuanya dibatalkan. Mengembalikan waktu server transaksi.
create or replace function public.apply_batch(ops jsonb) returns timestamptz
language plpgsql security invoker set search_path = public as $$
declare
  o jsonb; tbl text; rid text; kind text; d jsonb; del jsonb; logo text; keys text[]; n int;
begin
  if jsonb_typeof(ops) <> 'array' then raise exception 'ops harus berupa array' using errcode = '22023'; end if;
  for o in select * from jsonb_array_elements(ops) loop
    tbl := o ->> 't'; rid := o ->> 'id'; kind := o ->> 'op';
    d := coalesce(o -> 'data', '{}'::jsonb); del := coalesce(o -> 'del', '[]'::jsonb);
    if tbl not in ('teams','players','matches','events','settings') then raise exception 'tabel tidak dikenal: %', tbl using errcode = '22023'; end if;
    if rid is null or rid = '' or position('/' in rid) > 0 then raise exception 'id tidak sah' using errcode = '22023'; end if;
    if kind not in ('set','merge','update','delete') then raise exception 'op tidak dikenal: %', kind using errcode = '22023'; end if;

    if tbl = 'teams' then
      d := d - 'logoHash';   -- diatur server, bukan klien
      if kind = 'delete' then
        delete from team_logos where id = rid;
      else
        if d ? 'logoUrl' then
          logo := d ->> 'logoUrl';
          d := d - 'logoUrl';
          if logo is null or logo = '' then
            delete from team_logos where id = rid;
            del := del || '"logoHash"'::jsonb;
          else
            insert into team_logos (id, logo, hash) values (rid, logo, md5(logo))
              on conflict (id) do update set logo = excluded.logo, hash = excluded.hash;
            d := d || jsonb_build_object('logoHash', md5(logo));
          end if;
        elsif del ? 'logoUrl' then
          delete from team_logos where id = rid;
          del := del || '"logoHash"'::jsonb;
        elsif kind = 'set' then
          delete from team_logos where id = rid;   -- dokumen diganti tanpa logo
        end if;
      end if;
    end if;

    if kind = 'delete' then
      execute format('delete from public.%I where id = $1', tbl) using rid;
    elsif kind = 'set' then
      execute format('insert into public.%I (id, data) values ($1, $2) on conflict (id) do update set data = excluded.data', tbl) using rid, d;
    elsif kind = 'merge' then
      execute format('insert into public.%I (id, data) values ($1, $2) on conflict (id) do update set data = public.jsonb_deep_merge(%I.data, excluded.data)', tbl, tbl) using rid, d;
    else
      select coalesce(array_agg(x), '{}') into keys from jsonb_array_elements_text(del) x;
      execute format('update public.%I set data = (data || $2) - $3 where id = $1', tbl) using rid, d, keys;
      get diagnostics n = row_count;
      if n = 0 then raise exception 'dokumen % / % tidak ditemukan', tbl, rid using errcode = 'P0002'; end if;
    end if;
  end loop;
  return now();
end $$;
revoke all on function public.apply_batch(jsonb) from public;
grant execute on function public.apply_batch(jsonb) to authenticated;

-- ---------- Realtime (supaya skor live masuk tanpa muat ulang) ----------
do $$
declare t text;
begin
  foreach t in array array['teams','players','matches','events','settings'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- ---------- LANGKAH TERAKHIR (manual, sekali saja) ----------
-- 1. Authentication -> Users -> Add user -> isi email + password admin (centang Auto Confirm User).
-- 2. Salin "User UID" akun itu, lalu jalankan baris ini (ganti UID-nya):
--      insert into public.admins (uid) values ('GANTI-DENGAN-USER-UID') on conflict do nothing;
