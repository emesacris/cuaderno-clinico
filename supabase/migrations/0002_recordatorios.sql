-- Recordatorios de cita por email (24 h antes)
alter table public.settings
  add column if not exists recordatorio_activo boolean not null default true,
  add column if not exists recordatorio_asunto text not null default 'Recordatorio: tu sesión del {fecha}',
  add column if not exists recordatorio_plantilla text not null default 'Hola {nombre}, te recuerdo que tenemos sesión el {fecha}.' || chr(10) || 'Si no puedes venir, avísame cuanto antes respondiendo a este email.' || chr(10) || chr(10) || 'Un saludo.';
alter table public.sessions add column if not exists recordatorio_enviado_at timestamptz;
create index if not exists sessions_recordatorio_idx on public.sessions (fecha) where estado = 'programada' and recordatorio_enviado_at is null;
