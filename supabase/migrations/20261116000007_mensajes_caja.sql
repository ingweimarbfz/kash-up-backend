-- Mensajes de caja con formato colombiano ($ 1.000.000) y texto válido para préstamos y devoluciones.
create or replace function public.cop(v numeric) returns text
language sql immutable set search_path = '' as $$
  select '$ ' || replace(to_char(round(coalesce(v, 0)), 'FM999,999,999,990'), ',', '.')
$$;

create or replace function public.apply_fund_movement() returns trigger
language plpgsql set search_path = '' as $$
declare a record; v_pct numeric; v_reserve numeric; v_who text;
begin
  select * into a from public.fund_accounts where id = new.account_id and org_id = new.org_id for update;
  if a.id is null then raise exception 'Cuenta no encontrada' using errcode = 'P0001'; end if;
  if a.kind = 'negocio' and new.type in ('aporte', 'retiro') then
    update public.fund_accounts set capital = capital + new.amount where id = a.id;
    a.capital := a.capital + new.amount;
  end if;
  if a.balance + new.amount < 0 then
    if a.kind = 'negocio' then
      raise exception 'Saldo insuficiente en la cuenta del negocio (disponible: %)', public.cop(a.balance) using errcode = 'P0001';
    end if;
    select trim(name || ' ' || coalesce(last_name, '')) into v_who from public.users where id = a.user_id;
    raise exception 'Saldo insuficiente en la caja de % (disponible: %)', v_who, public.cop(a.balance) using errcode = 'P0001';
  end if;
  if a.kind = 'negocio' and new.amount < 0 then
    select coalesce(min_reserve_pct, 10) into v_pct from public.app_settings where org_id = new.org_id;
    v_pct := coalesce(v_pct, 10);
    v_reserve := round(greatest(a.capital, 0) * v_pct / 100);
    if a.balance + new.amount < v_reserve then
      raise exception 'La cuenta del negocio debe conservar la reserva mínima del % %% (%). Disponible para usar: %',
        trim(trailing '.' from to_char(v_pct, 'FM990.99')), public.cop(v_reserve), public.cop(greatest(a.balance - v_reserve, 0)) using errcode = 'P0001';
    end if;
  end if;
  update public.fund_accounts set balance = balance + new.amount where id = a.id returning balance into new.balance_after;
  return new;
end $$;
revoke execute on function public.cop(numeric), public.apply_fund_movement() from public, anon, authenticated;
