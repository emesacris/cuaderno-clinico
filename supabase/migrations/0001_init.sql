-- Cuaderno Clínico: esquema inicial
-- Cada fila pertenece a una profesional (owner_id = auth.uid()). RLS impide ver datos de otra cuenta.

create extension if not exists pgcrypto;

create table public.patients (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  nombre text not null,
  nacimiento date,
  tel text,
  email text,
  inicio timestamptz not null default now(),
  estado text not null default 'activo' check (estado in ('activo','pausa','alta')),
  motivo text,
  dx text,
  tarifa numeric(8,2) not null default 60,
  escala text,
  riesgo text,
  created_at timestamptz not null default now()
);

create table public.measures (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  patient_id uuid not null references public.patients(id) on delete cascade,
  fecha date not null,
  valor numeric(8,2) not null
);

create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  patient_id uuid not null references public.patients(id) on delete cascade,
  fecha timestamptz not null,
  dur int not null default 50,
  tipo text not null default 'Presencial' check (tipo in ('Presencial','Online')),
  estado text not null default 'programada' check (estado in ('programada','realizada','cancelada')),
  nota_temas text, nota_intervencion text, nota_observaciones text, nota_plan text,
  resumen text, resumen_fecha timestamptz,
  -- cobro
  importe numeric(8,2),
  pago_estado text check (pago_estado in ('pendiente','pagado','fallido')),
  pago_url text,
  stripe_payment_link_id text unique,
  stripe_price_id text,
  pago_email_enviado_at timestamptz,
  pagado_at timestamptz,
  invoice_id uuid,
  created_at timestamptz not null default now()
);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  patient_id uuid not null references public.patients(id) on delete restrict,
  session_id uuid references public.sessions(id) on delete set null,
  num text not null,
  fecha date not null default current_date,
  concepto text not null,
  importe numeric(8,2) not null,
  pagada boolean not null default false,
  stripe_checkout_id text,
  unique (owner_id, num)
);
alter table public.sessions add constraint sessions_invoice_fk foreign key (invoice_id) references public.invoices(id) on delete set null;

create table public.settings (
  owner_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  nombre_consulta text,
  email_respuesta text,
  plantilla_asunto text not null default 'Tu sesión del {fecha}',
  plantilla text not null default 'Hola {nombre}, te confirmo la sesión del {fecha}.' || chr(10) || 'Puedes abonarla ({importe}) de forma segura en este enlace:' || chr(10) || '{enlace}' || chr(10) || chr(10) || 'Un saludo.',
  pago_automatico boolean not null default true
);

-- RLS: cada cuenta solo ve y toca lo suyo
do $$ declare t text; begin
  foreach t in array array['patients','measures','sessions','invoices','settings'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy owner_all on public.%I for all using (owner_id = auth.uid()) with check (owner_id = auth.uid())', t);
  end loop;
end $$;

-- Numeración de facturas correlativa por año y profesional (2026-0001, 2026-0002…)
create or replace function public.next_invoice_num(p_owner uuid) returns text
language plpgsql security definer set search_path = public as $$
declare y text := to_char(now(), 'YYYY'); n int;
begin
  perform pg_advisory_xact_lock(hashtext(p_owner::text || y));
  select coalesce(max(split_part(num,'-',2)::int),0)+1 into n from invoices where owner_id = p_owner and num like y || '-%';
  return y || '-' || lpad(n::text, 4, '0');
end $$;
revoke all on function public.next_invoice_num(uuid) from public, anon, authenticated;

create index on public.sessions (owner_id, fecha);
create index on public.invoices (owner_id, fecha);

-- La app pide el siguiente número de factura para la cuenta que ha iniciado sesión
create or replace function public.my_next_invoice_num() returns text
language sql security definer set search_path = public as $$ select public.next_invoice_num(auth.uid()) $$;
revoke all on function public.my_next_invoice_num() from public, anon;
grant execute on function public.my_next_invoice_num() to authenticated;

-- Avisos en tiempo real a la app cuando Stripe confirma un pago
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.sessions, public.invoices;
  end if;
end $$;
