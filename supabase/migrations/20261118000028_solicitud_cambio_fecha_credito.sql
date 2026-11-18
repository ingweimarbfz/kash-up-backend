-- =====================================================================
-- KU-035 · El prestamista solicita cambiar la fecha de cobro de un crédito
-- El prestamista no edita directo: envía la solicitud con el motivo y el administrador la aprueba
-- (se aplica como una edición, con edit_credit) o la rechaza. Una solicitud pendiente por crédito.
-- =====================================================================
create table if not exists public.credit_change_requests (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  credit_id bigint not null references public.credits(id) on delete cascade,
  lender_id bigint references public.users(id) on delete set null,
  from_number integer not null,
  new_date date not null,
  mode text not null default 'siguientes' check (mode in ('siguientes', 'una')),
  skip_sundays boolean not null,
  changes jsonb not null default '[]'::jsonb,       -- vista previa al pedir: [{ number, from, to }]
  reason text not null check (char_length(reason) between 5 and 300),
  status text not null default 'pendiente' check (status in ('pendiente', 'aprobada', 'rechazada', 'cancelada')),
  resolution text,
  requested_by bigint references public.users(id) on delete set null,
  resolved_by bigint references public.users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists credit_change_requests_pending_key on public.credit_change_requests (credit_id) where status = 'pendiente';
create index if not exists credit_change_requests_org_idx on public.credit_change_requests (org_id, status, created_at desc);
alter table public.credit_change_requests enable row level security;
revoke all on public.credit_change_requests from anon, authenticated;
