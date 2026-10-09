-- =====================================================================
-- FLUFFY MASTER · versión web · base de datos en Supabase
-- Pega TODO este archivo en Supabase → SQL Editor → New query → Run.
-- Al final hay una línea para darte acceso de administración: cámbiala y córrela.
-- =====================================================================

-- Quién puede entrar y con qué rol. Solo los correos de esta tabla ven datos.
create table if not exists public.members (
  email      text primary key check (email = lower(email)),
  name       text not null,
  role       text not null check (role in ('admin', 'editor', 'recepcion', 'lectura')),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

-- Todos los registros de la app (ventas, gastos, citas, depósitos, configuración…),
-- uno por fila. "collection" es el tipo de registro e "id" su identificador.
create table if not exists public.docs (
  collection text not null,
  id         text not null,
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text,
  primary key (collection, id)
);
create index if not exists docs_collection_idx on public.docs (collection);

-- Rol de quien está conectado (null si no está dado de alta o está desactivado).
create or replace function public.fm_role() returns text
language sql stable security definer set search_path = public as $$
  select role from public.members where email = lower(auth.jwt() ->> 'email') and active
$$;

-- Qué puede escribir cada rol.
create or replace function public.fm_can_write(col text) returns boolean
language sql stable security definer set search_path = public as $$
  select case public.fm_role()
    when 'admin'     then true
    when 'editor'    then col not in ('security', 'historico')
    when 'recepcion' then col in ('sales', 'deposits', 'appointments', 'packages', 'supplyRequests', 'dayNotes', 'auditLogs')
    else false
  end
$$;

-- La fecha y el autor de cada cambio los pone la base, no el navegador.
create or replace function public.fm_touch() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce(auth.jwt() ->> 'email', new.updated_by);
  return new;
end $$;
drop trigger if exists docs_touch on public.docs;
create trigger docs_touch before insert or update on public.docs for each row execute function public.fm_touch();

-- El historial de cambios no se puede editar ni borrar.
create or replace function public.fm_audit_append_only() returns trigger
language plpgsql as $$
begin
  if old.collection = 'auditLogs' then raise exception 'El historial de cambios no se puede modificar.'; end if;
  return coalesce(new, old);
end $$;
drop trigger if exists docs_audit_guard on public.docs;
create trigger docs_audit_guard before update or delete on public.docs for each row execute function public.fm_audit_append_only();

-- Seguridad por filas (RLS): sin una política que lo permita, nadie lee ni escribe.
alter table public.docs    enable row level security;
alter table public.members enable row level security;

drop policy if exists docs_read   on public.docs;
drop policy if exists docs_insert on public.docs;
drop policy if exists docs_update on public.docs;
drop policy if exists docs_delete on public.docs;
create policy docs_read   on public.docs for select to authenticated using (public.fm_role() is not null);
create policy docs_insert on public.docs for insert to authenticated with check (public.fm_can_write(collection));
create policy docs_update on public.docs for update to authenticated using (public.fm_can_write(collection)) with check (public.fm_can_write(collection));
create policy docs_delete on public.docs for delete to authenticated using (public.fm_can_write(collection) and collection <> 'historico');

drop policy if exists members_read  on public.members;
drop policy if exists members_admin on public.members;
create policy members_read  on public.members for select to authenticated using (email = lower(auth.jwt() ->> 'email') or public.fm_role() = 'admin');
create policy members_admin on public.members for all    to authenticated using (public.fm_role() = 'admin') with check (public.fm_role() = 'admin');

-- Cambios en vivo: lo que registra recepción aparece al instante en las otras pantallas.
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;

-- =====================================================================
-- TU ACCESO DE ADMINISTRACIÓN: cambia el correo y el nombre, y corre solo esta línea.
-- insert into public.members (email, name, role) values ('tu-correo@ejemplo.com', 'Amy', 'admin');
-- =====================================================================
