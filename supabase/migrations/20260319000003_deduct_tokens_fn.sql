-- Atomic token deduction (prevents double-spend)
create or replace function public.deduct_tokens(p_user_id uuid, p_amount decimal)
returns decimal as $$
declare
  v_balance decimal;
begin
  select token_balance into v_balance
  from public.profiles
  where id = p_user_id
  for update;  -- row-level lock

  if v_balance < p_amount then
    raise exception 'Insufficient token balance: % < %', v_balance, p_amount;
  end if;

  update public.profiles
  set token_balance = token_balance - p_amount
  where id = p_user_id
  returning token_balance into v_balance;

  return v_balance;
end;
$$ language plpgsql security definer;
