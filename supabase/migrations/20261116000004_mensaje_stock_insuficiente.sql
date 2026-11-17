-- Mensaje claro cuando no alcanza el stock (antes saltaba la restricción products_stock_check).
create or replace function public.apply_inventory_movement() returns trigger
language plpgsql set search_path = '' as $$
declare s integer; n text;
begin
  select stock, name into s, n from public.products where id = new.product_id and org_id = new.org_id for update;
  if s is null then raise exception 'Producto no encontrado' using errcode = 'P0001'; end if;
  if s + new.quantity < 0 then raise exception 'Stock insuficiente de "%" (disponible: %)', n, s using errcode = 'P0001'; end if;
  update public.products set stock = stock + new.quantity where id = new.product_id;
  if new.type = 'entrada' and new.unit_cost is not null then
    update public.products set cost = new.unit_cost where id = new.product_id;
  end if;
  return new;
end $$;
revoke execute on function public.apply_inventory_movement() from public, anon, authenticated;
