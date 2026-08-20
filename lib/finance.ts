import { supabase } from '@/lib/supabase';
import type {
  ActivityExpense,
  ActivityObligation,
  FundingMode,
  ObligationStatus,
  Profile,
  SeriesFinanceSettings,
  SplitMode,
} from '@/lib/types';
import { displayName } from '@/lib/types';

export function seriesKey(activity: { id: string; series_id?: string | null }): string {
  return activity.series_id ?? activity.id;
}

export function obligationOpenAmount(o: Pick<ActivityObligation, 'amount_due' | 'amount_paid' | 'status'>): number {
  if (o.status === 'waived' || o.status === 'paid') return 0;
  return Math.max(0, Number(o.amount_due) - Number(o.amount_paid));
}

export async function fetchSeriesFinanceSettings(seriesId: string): Promise<SeriesFinanceSettings | null> {
  const { data, error } = await supabase
    .from('series_finance_settings')
    .select('*')
    .eq('series_id', seriesId)
    .maybeSingle();
  if (error) throw error;
  return (data as SeriesFinanceSettings) ?? null;
}

export async function upsertSeriesFinanceSettings(input: {
  seriesId: string;
  fundingMode: FundingMode;
  amount: number;
  userId: string;
}): Promise<void> {
  const { error } = await supabase.from('series_finance_settings').upsert(
    {
      series_id: input.seriesId,
      funding_mode: input.fundingMode,
      amount: input.amount,
      updated_by: input.userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'series_id' }
  );
  if (error) throw error;
}

export async function fetchSeriesMemberProfiles(seriesId: string): Promise<Profile[]> {
  const { data: acts } = await supabase
    .from('activities')
    .select('id')
    .or(`id.eq.${seriesId},series_id.eq.${seriesId}`);
  const ids = (acts ?? []).map((a: { id: string }) => a.id);
  if (!ids.length) return [];

  const { data: joins } = await supabase.from('activity_joins').select('user_id').in('activity_id', ids);
  const userIds = Array.from(new Set((joins ?? []).map((j: { user_id: string }) => j.user_id)));
  if (!userIds.length) return [];

  const { data: profiles } = await supabase.from('profiles').select('*').in('id', userIds);
  return ((profiles as Profile[]) ?? []).sort((a, b) =>
    displayName(a).localeCompare(displayName(b), undefined, { sensitivity: 'base' })
  );
}

export async function fetchActivityAttendeeIds(activityId: string): Promise<string[]> {
  const { data } = await supabase.from('activity_joins').select('user_id').eq('activity_id', activityId);
  return (data ?? []).map((j: { user_id: string }) => j.user_id);
}

export type ObligationWithMeta = ActivityObligation & {
  profiles?: Pick<Profile, 'id' | 'first_name' | 'last_name' | 'email'> | null;
  activity_expenses?: Pick<ActivityExpense, 'id' | 'title' | 'expense_type' | 'period_key' | 'amount'> | null;
};

export async function fetchSeriesObligations(seriesId: string): Promise<ObligationWithMeta[]> {
  const { data, error } = await supabase
    .from('activity_obligations')
    .select('*, profiles(id, first_name, last_name, email), activity_expenses(id, title, expense_type, period_key, amount)')
    .eq('series_id', seriesId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data as ObligationWithMeta[]) ?? [];
}

export async function fetchSeriesExpenses(seriesId: string): Promise<ActivityExpense[]> {
  const { data, error } = await supabase
    .from('activity_expenses')
    .select('*')
    .eq('series_id', seriesId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data as ActivityExpense[]) ?? [];
}

export type FinanceSummary = {
  totalCosts: number;
  paid: number;
  unpaid: number;
  debtorCount: number;
};

export function summarizeFinance(obligations: ActivityObligation[]): FinanceSummary {
  let totalCosts = 0;
  let paid = 0;
  let unpaid = 0;
  const debtors = new Set<string>();

  for (const o of obligations) {
    totalCosts += Number(o.amount_due) || 0;
    if (o.status === 'waived') continue;
    paid += Number(o.amount_paid) || 0;
    const open = obligationOpenAmount(o);
    unpaid += open;
    if (open > 0.001) debtors.add(o.user_id);
  }

  return {
    totalCosts: round2(totalCosts),
    paid: round2(paid),
    unpaid: round2(unpaid),
    debtorCount: debtors.size,
  };
}

export type DebtorGroup = {
  userId: string;
  profile: Pick<Profile, 'id' | 'first_name' | 'last_name' | 'email'> | null;
  items: { label: string; amount: number; obligationId: string; status: ObligationStatus }[];
  totalOpen: number;
};

export function groupDebtors(obligations: ObligationWithMeta[]): DebtorGroup[] {
  const map = new Map<string, DebtorGroup>();
  for (const o of obligations) {
    const open = obligationOpenAmount(o);
    if (open <= 0.001) continue;
    const existing = map.get(o.user_id) ?? {
      userId: o.user_id,
      profile: o.profiles ?? null,
      items: [],
      totalOpen: 0,
    };
    const exp = o.activity_expenses;
    const label =
      exp?.period_key ||
      exp?.title ||
      (exp?.expense_type === 'per_event' ? 'Event' : exp?.expense_type ?? 'Expense');
    existing.items.push({
      label,
      amount: open,
      obligationId: o.id,
      status: o.status,
    });
    existing.totalOpen = round2(existing.totalOpen + open);
    map.set(o.user_id, existing);
  }
  return Array.from(map.values()).sort((a, b) => b.totalOpen - a.totalOpen);
}

export async function createExpense(input: {
  seriesId: string;
  expenseType: ActivityExpense['expense_type'];
  title: string;
  amount: number;
  splitMode: SplitMode;
  memberIds: string[];
  activityId?: string | null;
  periodKey?: string | null;
  dueDate?: string | null;
}): Promise<string> {
  const { data, error } = await supabase.rpc('create_series_expense', {
    p_series_id: input.seriesId,
    p_expense_type: input.expenseType,
    p_title: input.title,
    p_amount: input.amount,
    p_split_mode: input.splitMode,
    p_member_ids: input.memberIds,
    p_activity_id: input.activityId ?? null,
    p_period_key: input.periodKey ?? null,
    p_due_date: input.dueDate ?? null,
  });
  if (error) throw error;
  return data as string;
}

/** Settle current occurrence using per_event funding amount among attendees. */
export async function settlePerEventOccurrence(input: {
  seriesId: string;
  activityId: string;
  amount: number;
  title: string;
  attendeeIds: string[];
}): Promise<string> {
  if (input.attendeeIds.length === 0) throw new Error('No attendees to split among.');
  return createExpense({
    seriesId: input.seriesId,
    expenseType: 'per_event',
    title: input.title,
    amount: input.amount,
    splitMode: 'equal_attendees',
    memberIds: input.attendeeIds,
    activityId: input.activityId,
    periodKey: input.title,
  });
}

export async function generateMembershipObligations(input: {
  seriesId: string;
  mode: 'monthly' | 'annual';
  feePerMember: number;
  memberIds: string[];
  periodKey: string;
  title: string;
  dueDate?: string | null;
}): Promise<string> {
  const { data: existing } = await supabase
    .from('activity_expenses')
    .select('id')
    .eq('series_id', input.seriesId)
    .eq('expense_type', input.mode)
    .eq('period_key', input.periodKey)
    .limit(1)
    .maybeSingle();
  if (existing?.id) throw new Error('This period was already generated.');

  if (!input.memberIds.length) throw new Error('No members.');

  // create_series_expense splits total equally — pass total = fee * n so each gets fee
  return createExpense({
    seriesId: input.seriesId,
    expenseType: input.mode,
    title: input.title,
    amount: round2(input.feePerMember * input.memberIds.length),
    splitMode: 'equal_all',
    memberIds: input.memberIds,
    periodKey: input.periodKey,
    dueDate: input.dueDate ?? null,
  });
}

export async function recordPayment(obligationId: string, amount: number, note?: string): Promise<void> {
  const { error } = await supabase.rpc('record_obligation_payment', {
    p_obligation_id: obligationId,
    p_amount: amount,
    p_note: note ?? null,
  });
  if (error) throw error;
}

export async function waiveObligation(obligationId: string): Promise<void> {
  const { error } = await supabase.rpc('waive_obligation', { p_obligation_id: obligationId });
  if (error) throw error;
}

export type PersonalFinance = {
  paidThisYear: number;
  openAmount: number;
  nextDueDate: string | null;
  obligations: ObligationWithMeta[];
};

export async function fetchMyFinance(userId: string): Promise<PersonalFinance> {
  const year = new Date().getFullYear();
  const { data, error } = await supabase
    .from('activity_obligations')
    .select('*, activity_expenses(id, title, expense_type, period_key, amount)')
    .eq('user_id', userId)
    .order('due_date', { ascending: true, nullsFirst: false });
  if (error) throw error;
  const rows = (data as ObligationWithMeta[]) ?? [];

  let paidThisYear = 0;
  let openAmount = 0;
  let nextDueDate: string | null = null;

  for (const o of rows) {
    const createdYear = new Date(o.created_at).getFullYear();
    if (createdYear === year && o.status !== 'waived') {
      paidThisYear += Number(o.amount_paid) || 0;
    }
    const open = obligationOpenAmount(o);
    openAmount += open;
    if (open > 0.001 && o.due_date) {
      if (!nextDueDate || o.due_date < nextDueDate) nextDueDate = o.due_date;
    }
  }

  return {
    paidThisYear: round2(paidThisYear),
    openAmount: round2(openAmount),
    nextDueDate,
    obligations: rows,
  };
}

export function currentMonthKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function currentYearKey(d = new Date()): string {
  return String(d.getFullYear());
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
