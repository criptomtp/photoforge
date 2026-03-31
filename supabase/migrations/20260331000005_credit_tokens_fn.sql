-- Atomic token credit (prevents lost updates from concurrent purchases)
create or replace function public.credit_tokens(p_user_id uuid, p_amount decimal)
returns decimal as $$
declare
  v_balance decimal;
begin
  update public.profiles
  set token_balance = token_balance + p_amount
  where id = p_user_id
  returning token_balance into v_balance;

  return v_balance;
end;
$$ language plpgsql security definer;

-- Atomic generation counter increment
create or replace function public.increment_generations_used(p_user_id uuid)
returns void as $$
begin
  update public.profiles
  set generations_used = generations_used + 1
  where id = p_user_id;
end;
$$ language plpgsql security definer;
