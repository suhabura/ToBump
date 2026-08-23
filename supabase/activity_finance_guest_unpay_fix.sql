-- Fix: unmarking a guest as unpaid must remove their INCOME from the budget.
-- Safe to re-run (also included at end of activity_finance_guest_debt.sql).

alter table public.activity_guest_attendances
  add column if not exists ledger_income_id uuid
    references public.series_finance_ledger(id) on delete set null;

create or replace function public.set_guest_attendance_paid(
  p_attendance_id uuid,
  p_paid boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  att public.activity_guest_attendances%rowtype;
  gname text;
  remaining numeric;
  lid uuid;
  desc_text text;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;

  select * into att from public.activity_guest_attendances where id = p_attendance_id for update;
  if not found then raise exception 'Guest attendance not found'; end if;
  if not public.can_manage_series_finance(att.series_id) then
    raise exception 'Not allowed';
  end if;
  if att.is_free or coalesce(att.amount, 0) <= 0 or att.fee_treatment = 'none' then
    raise exception 'No guest fee to collect';
  end if;
  if att.payment_status = 'waived' then raise exception 'Guest fee is waived'; end if;

  select name into gname from public.activity_guests where id = att.guest_id;
  desc_text := coalesce(format('Guest fee: %s', gname), 'Guest fee');

  if coalesce(p_paid, false) then
    remaining := greatest(coalesce(att.amount, 0) - coalesce(att.amount_paid, 0), 0);
    if remaining > 0.001 then
      insert into public.series_finance_ledger (
        series_id, entry_type, amount, occurred_at, activity_id, description, created_by
      ) values (
        att.series_id,
        'INCOME',
        remaining,
        now(),
        att.activity_id,
        desc_text,
        auth.uid()
      ) returning id into lid;
    else
      lid := att.ledger_income_id;
    end if;
    update public.activity_guest_attendances
    set
      amount_paid = amount,
      payment_status = 'paid',
      ledger_income_id = coalesce(lid, ledger_income_id)
    where id = p_attendance_id;
  else
    if att.ledger_income_id is not null then
      delete from public.series_finance_ledger where id = att.ledger_income_id;
    else
      delete from public.series_finance_ledger l
      where l.id in (
        select l2.id
        from public.series_finance_ledger l2
        where l2.series_id = att.series_id
          and l2.entry_type = 'INCOME'
          and l2.activity_id is not distinct from att.activity_id
          and l2.description = desc_text
          and abs(l2.amount - coalesce(att.amount_paid, att.amount, 0)) < 0.011
        order by l2.occurred_at desc
        limit 1
      );
    end if;

    update public.activity_guest_attendances
    set amount_paid = 0, payment_status = 'unpaid', ledger_income_id = null
    where id = p_attendance_id;
  end if;
end;
$$;

grant execute on function public.set_guest_attendance_paid(uuid, boolean) to authenticated;
