import { supabase } from '@/lib/supabase';
import type {
  ActivityExpense,
  ActivityObligation,
  ActivitySettlement,
  Profile,
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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function fetchSeriesMemberProfiles(seriesId: string): Promise<Profile[]> {
  const { data: acts } = await supabase
    .from('activities')
    .select('id, created_by, series_invite_user_ids')
    .or(`id.eq.${seriesId},series_id.eq.${seriesId}`);
  const ids = (acts ?? []).map((a: { id: string }) => a.id);
  const ownerIds = (acts ?? []).map((a: { created_by: string }) => a.created_by);
  const seriesInviteIds = (acts ?? []).flatMap(
    (a: { series_invite_user_ids?: string[] | null }) => a.series_invite_user_ids ?? []
  );
  if (!ids.length) return [];

  const [{ data: joins }, { data: invites }] = await Promise.all([
    supabase.from('activity_joins').select('user_id').in('activity_id', ids),
    supabase.from('activity_invites').select('user_id').in('activity_id', ids),
  ]);

  const userIds = Array.from(
    new Set([
      ...ownerIds,
      ...seriesInviteIds,
      ...(joins ?? []).map((j: { user_id: string }) => j.user_id),
      ...(invites ?? []).map((i: { user_id: string }) => i.user_id),
    ])
  );
  if (!userIds.length) return [];

  const { data: profiles } = await supabase.from('profiles').select('*').in('id', userIds);
  return ((profiles as Profile[]) ?? []).sort((a, b) =>
    displayName(a).localeCompare(displayName(b), undefined, { sensitivity: 'base' })
  );
}

/** Invitees for the series (includes series_invite_user_ids + activity_invites). */
export async function fetchSeriesInviteeIds(seriesId: string): Promise<string[]> {
  const { data: acts } = await supabase
    .from('activities')
    .select('id, created_by, series_invite_user_ids')
    .or(`id.eq.${seriesId},series_id.eq.${seriesId}`);
  const ids = (acts ?? []).map((a: { id: string }) => a.id);
  const ownerIds = (acts ?? []).map((a: { created_by: string }) => a.created_by);
  const seriesInviteIds = (acts ?? []).flatMap(
    (a: { series_invite_user_ids?: string[] | null }) => a.series_invite_user_ids ?? []
  );
  if (!ids.length) {
    return Array.from(new Set([...ownerIds, ...seriesInviteIds]));
  }

  const { data: invites } = await supabase
    .from('activity_invites')
    .select('user_id')
    .in('activity_id', ids);

  return Array.from(
    new Set([
      ...ownerIds,
      ...seriesInviteIds,
      ...(invites ?? []).map((i: { user_id: string }) => i.user_id),
    ])
  );
}

export async function fetchActivityAttendeeIds(activityId: string): Promise<string[]> {
  const { data } = await supabase.from('activity_joins').select('user_id').eq('activity_id', activityId);
  return (data ?? []).map((j: { user_id: string }) => j.user_id);
}

export type ExpenseWithMeta = ActivityExpense & {
  payer?: Pick<Profile, 'id' | 'first_name' | 'last_name' | 'email'> | null;
  members?: { user_id: string; profiles?: Pick<Profile, 'id' | 'first_name' | 'last_name' | 'email'> | null }[];
};

export async function fetchSeriesExpenses(seriesId: string): Promise<ExpenseWithMeta[]> {
  const { data, error } = await supabase
    .from('activity_expenses')
    .select('*, activity_expense_members(user_id, profiles(id, first_name, last_name, email))')
    .eq('series_id', seriesId)
    .order('created_at', { ascending: false });
  if (error) throw error;

  type Row = ExpenseWithMeta & {
    activity_expense_members?: ExpenseWithMeta['members'];
  };
  const rows = (data as Row[]) ?? [];
  const payerIds = Array.from(new Set(rows.map((r) => r.paid_by).filter(Boolean) as string[]));
  let payers: Profile[] = [];
  if (payerIds.length) {
    const { data: p } = await supabase
      .from('profiles')
      .select('id, first_name, last_name, email')
      .in('id', payerIds);
    payers = (p as Profile[]) ?? [];
  }
  const byId = new Map(payers.map((p) => [p.id, p]));
  return rows.map((r) => ({
    ...r,
    members: r.activity_expense_members,
    payer: r.paid_by ? byId.get(r.paid_by) ?? null : null,
  }));
}

export type SettlementWithMeta = ActivitySettlement & {
  from_profile?: Pick<Profile, 'id' | 'first_name' | 'last_name' | 'email'> | null;
  to_profile?: Pick<Profile, 'id' | 'first_name' | 'last_name' | 'email'> | null;
};

export async function fetchSeriesSettlements(seriesId: string): Promise<SettlementWithMeta[]> {
  const { data, error } = await supabase
    .from('activity_settlements')
    .select('*')
    .eq('series_id', seriesId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  const rows = (data as ActivitySettlement[]) ?? [];
  const ids = Array.from(
    new Set(rows.flatMap((r) => [r.from_user_id, r.to_user_id]))
  );
  if (!ids.length) return [];
  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, first_name, last_name, email')
    .in('id', ids);
  const byId = new Map(((profiles as Profile[]) ?? []).map((p) => [p.id, p]));
  return rows.map((r) => ({
    ...r,
    from_profile: byId.get(r.from_user_id) ?? null,
    to_profile: byId.get(r.to_user_id) ?? null,
  }));
}

/** Funding fee expenses (participant contributions into the budget pot). */
export function isFundingExpense(e: Pick<ActivityExpense, 'period_key'>): boolean {
  const key = e.period_key ?? '';
  return (
    key.startsWith('fee:') ||
    key === 'fixed' ||
    key.startsWith('event:') ||
    key.startsWith('month:')
  );
}

/** Actual costs (not participant fee contributions). */
export function isActualExpense(e: Pick<ActivityExpense, 'period_key'>): boolean {
  return !isFundingExpense(e);
}

/** Parse user id from per-person fee period_key (`fee:…:user:{uuid}`). */
export function fundingFeeUserId(periodKey: string | null | undefined): string | null {
  if (!periodKey?.startsWith('fee:')) return null;
  const m = periodKey.match(/:user:([0-9a-f-]{36})$/i);
  return m?.[1] ?? null;
}

export function computeBudget(
  expenses: ExpenseWithMeta[],
  obligations: Pick<ActivityObligation, 'expense_id' | 'amount_paid' | 'amount_due' | 'status'>[] = []
): {
  funded: number;
  spent: number;
  remaining: number;
} {
  const paidByExpense = new Map<string, number>();
  for (const o of obligations) {
    if (o.status === 'waived') continue;
    paidByExpense.set(
      o.expense_id,
      round2((paidByExpense.get(o.expense_id) ?? 0) + (Number(o.amount_paid) || 0))
    );
  }

  let funded = 0;
  let spent = 0;
  for (const e of expenses) {
    const amount = Number(e.amount) || 0;
    if (isFundingExpense(e)) {
      if (paidByExpense.has(e.id)) funded = round2(funded + (paidByExpense.get(e.id) ?? 0));
      else funded = round2(funded + amount);
    } else if (e.paid_from_budget) {
      spent = round2(spent + amount);
    }
  }
  return { funded, spent, remaining: round2(funded - spent) };
}

export async function fetchSeriesObligations(seriesId: string): Promise<ActivityObligation[]> {
  const { data, error } = await supabase
    .from('activity_obligations')
    .select('*')
    .eq('series_id', seriesId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data as ActivityObligation[]) ?? [];
}

/** Organizer/editor: mark a fee obligation fully paid or unpaid. */
export async function setObligationPaid(obligationId: string, paid: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_obligation_paid', {
    p_obligation_id: obligationId,
    p_paid: paid,
  });
  if (error) throw error;
}

/** Charge selected people an extra amount into the budget (unpaid until checked). */
export async function createExtraFundingCharges(input: {
  seriesId: string;
  activityId: string;
  title: string;
  amount: number;
  userIds: string[];
  organizerId: string;
}): Promise<void> {
  const batch =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}`;
  for (const uid of input.userIds) {
    await createExpense({
      seriesId: input.seriesId,
      expenseType: 'manual',
      title: input.title,
      amount: input.amount,
      splitMode: 'selected',
      memberIds: [uid],
      paidBy: input.organizerId,
      activityId: input.activityId,
      periodKey: `fee:extra:${batch}:user:${uid}`,
    });
  }
}

/** Positive = owed money; negative = owes money. */
export type PersonBalance = {
  userId: string;
  profile: Pick<Profile, 'id' | 'first_name' | 'last_name' | 'email'> | null;
  net: number;
};

export type SuggestedTransfer = {
  fromUserId: string;
  toUserId: string;
  fromProfile: Pick<Profile, 'id' | 'first_name' | 'last_name' | 'email'> | null;
  toProfile: Pick<Profile, 'id' | 'first_name' | 'last_name' | 'email'> | null;
  amount: number;
};

export function computeBalances(
  expenses: ExpenseWithMeta[],
  settlements: ActivitySettlement[],
  profilesById: Map<string, Pick<Profile, 'id' | 'first_name' | 'last_name' | 'email'>>
): PersonBalance[] {
  const nets = new Map<string, number>();

  const add = (userId: string, delta: number) => {
    nets.set(userId, round2((nets.get(userId) ?? 0) + delta));
  };

  for (const e of expenses) {
    // Paid from budget pot — no person-to-person debt
    if (e.paid_from_budget) continue;
    const amount = Number(e.amount) || 0;
    const payer = e.paid_by ?? e.created_by;
    const memberIds = (e.members ?? []).map((m) => m.user_id);
    if (!memberIds.length) continue;
    add(payer, amount);
    const share = round2(amount / memberIds.length);
    let allocated = 0;
    memberIds.forEach((uid, i) => {
      const part = i === memberIds.length - 1 ? round2(amount - allocated) : share;
      allocated = round2(allocated + part);
      add(uid, -part);
    });
  }

  for (const s of settlements) {
    const amount = Number(s.amount) || 0;
    // from paid to → from's debt decreases (net up), to is owed less (net down)
    add(s.from_user_id, amount);
    add(s.to_user_id, -amount);
  }

  return Array.from(nets.entries())
    .map(([userId, net]) => ({
      userId,
      profile: profilesById.get(userId) ?? null,
      net: round2(net),
    }))
    .filter((b) => Math.abs(b.net) > 0.001)
    .sort((a, b) => b.net - a.net);
}

/** Greedy minimize-transfers settlement suggestions (Tricount-style). */
export function suggestTransfers(balances: PersonBalance[]): SuggestedTransfer[] {
  const debtors = balances
    .filter((b) => b.net < -0.001)
    .map((b) => ({ ...b, net: b.net }))
    .sort((a, b) => a.net - b.net);
  const creditors = balances
    .filter((b) => b.net > 0.001)
    .map((b) => ({ ...b, net: b.net }))
    .sort((a, b) => b.net - a.net);

  const out: SuggestedTransfer[] = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const d = debtors[i];
    const c = creditors[j];
    const amount = round2(Math.min(-d.net, c.net));
    if (amount > 0.001) {
      out.push({
        fromUserId: d.userId,
        toUserId: c.userId,
        fromProfile: d.profile,
        toProfile: c.profile,
        amount,
      });
      d.net = round2(d.net + amount);
      c.net = round2(c.net - amount);
    }
    if (Math.abs(d.net) < 0.001) i += 1;
    if (Math.abs(c.net) < 0.001) j += 1;
  }
  return out;
}

export async function createExpense(input: {
  seriesId: string;
  expenseType?: ActivityExpense['expense_type'];
  title: string;
  amount: number;
  splitMode: SplitMode;
  memberIds: string[];
  /** Person who paid; omit / null when paidFromBudget. */
  paidBy?: string | null;
  paidFromBudget?: boolean;
  activityId?: string | null;
  periodKey?: string | null;
  dueDate?: string | null;
}): Promise<string> {
  const fromBudget = Boolean(input.paidFromBudget);
  const { data, error } = await supabase.rpc('create_series_expense', {
    p_series_id: input.seriesId,
    p_expense_type: input.expenseType ?? 'manual',
    p_title: input.title,
    p_amount: input.amount,
    p_split_mode: input.splitMode,
    p_member_ids: input.memberIds,
    p_activity_id: input.activityId ?? null,
    p_period_key: input.periodKey ?? null,
    p_due_date: input.dueDate ?? null,
    p_paid_by: fromBudget ? null : input.paidBy ?? null,
    p_paid_from_budget: fromBudget,
  });
  if (error) throw error;
  return data as string;
}

export async function recordSettlement(input: {
  seriesId: string;
  fromUserId: string;
  toUserId: string;
  amount: number;
  note?: string | null;
}): Promise<string> {
  const { data, error } = await supabase.rpc('record_series_settlement', {
    p_series_id: input.seriesId,
    p_from_user_id: input.fromUserId,
    p_to_user_id: input.toUserId,
    p_amount: input.amount,
    p_note: input.note ?? null,
  });
  if (error) throw error;
  return data as string;
}

export async function deleteExpense(expenseId: string): Promise<void> {
  const { error } = await supabase.from('activity_expenses').delete().eq('id', expenseId);
  if (error) throw error;
}

/** Update a fee/expense amount and matching obligations (organizer manual edit). */
export async function updateExpenseAmount(expenseId: string, amount: number): Promise<void> {
  const next = round2(amount);
  if (!Number.isFinite(next) || next < 0) throw new Error('Invalid amount');
  const { error } = await supabase.from('activity_expenses').update({ amount: next }).eq('id', expenseId);
  if (error) throw error;

  const { data: members } = await supabase
    .from('activity_expense_members')
    .select('user_id')
    .eq('expense_id', expenseId);
  const ids = (members ?? []).map((m: { user_id: string }) => m.user_id);
  if (!ids.length) return;

  const share = round2(next / ids.length);
  for (let i = 0; i < ids.length; i++) {
    const due = i === ids.length - 1 ? round2(next - share * (ids.length - 1)) : share;
    const { data: obl } = await supabase
      .from('activity_obligations')
      .select('id, amount_paid, status')
      .eq('expense_id', expenseId)
      .eq('user_id', ids[i])
      .maybeSingle();
    if (!obl) continue;
    const paid = Number(obl.amount_paid) || 0;
    let status = obl.status as string;
    if (status !== 'waived') {
      if (paid <= 0) status = 'unpaid';
      else if (paid + 0.001 >= due) status = 'paid';
      else status = 'partial';
    }
    await supabase
      .from('activity_obligations')
      .update({ amount_due: due, status, updated_at: new Date().toISOString() })
      .eq('id', obl.id);
  }
}

export type ObligationWithMeta = ActivityObligation & {
  profiles?: Pick<Profile, 'id' | 'first_name' | 'last_name' | 'email'> | null;
  activity_expenses?: Pick<ActivityExpense, 'id' | 'title' | 'expense_type' | 'period_key' | 'amount'> | null;
};

export type PersonalFinance = {
  youOwe: number;
  youAreOwed: number;
  expensesInvolved: number;
  recent: {
    seriesId: string;
    title: string;
    amount: number;
    paidByYou: boolean;
    createdAt: string;
  }[];
};

export async function fetchMyFinance(userId: string): Promise<PersonalFinance> {
  const { data: memberRows, error: mErr } = await supabase
    .from('activity_expense_members')
    .select('expense_id')
    .eq('user_id', userId);
  if (mErr) throw mErr;

  const expenseIds = Array.from(new Set((memberRows ?? []).map((r: { expense_id: string }) => r.expense_id)));
  const { data: paidRows } = await supabase
    .from('activity_expenses')
    .select('id, series_id, title, amount, paid_by, created_at')
    .eq('paid_by', userId)
    .order('created_at', { ascending: false })
    .limit(50);

  const allIds = Array.from(new Set([...expenseIds, ...((paidRows ?? []).map((e: { id: string }) => e.id))]));
  if (!allIds.length) {
    return { youOwe: 0, youAreOwed: 0, expensesInvolved: 0, recent: [] };
  }

  const { data: expenses, error } = await supabase
    .from('activity_expenses')
    .select('*, activity_expense_members(user_id)')
    .in('id', allIds)
    .order('created_at', { ascending: false });
  if (error) throw error;

  const seriesIds = Array.from(
    new Set(((expenses as ActivityExpense[]) ?? []).map((e) => e.series_id))
  );
  const { data: settlements } = seriesIds.length
    ? await supabase.from('activity_settlements').select('*').in('series_id', seriesIds)
    : { data: [] as ActivitySettlement[] };

  const bySeries = new Map<string, ExpenseWithMeta[]>();
  for (const e of (expenses as ExpenseWithMeta[]) ?? []) {
    const list = bySeries.get(e.series_id) ?? [];
    list.push({
      ...e,
      members: (e as ExpenseWithMeta & { activity_expense_members?: { user_id: string }[] })
        .activity_expense_members,
    });
    bySeries.set(e.series_id, list);
  }

  const settlementsBySeries = new Map<string, ActivitySettlement[]>();
  for (const s of (settlements as ActivitySettlement[]) ?? []) {
    const list = settlementsBySeries.get(s.series_id) ?? [];
    list.push(s);
    settlementsBySeries.set(s.series_id, list);
  }

  let youOwe = 0;
  let youAreOwed = 0;
  for (const [sid, exps] of bySeries) {
    const balances = computeBalances(exps, settlementsBySeries.get(sid) ?? [], new Map());
    const mine = balances.find((b) => b.userId === userId);
    if (!mine) continue;
    if (mine.net < 0) youOwe += -mine.net;
    if (mine.net > 0) youAreOwed += mine.net;
  }

  const recent = ((expenses as ExpenseWithMeta[]) ?? []).slice(0, 20).map((e) => ({
    seriesId: e.series_id,
    title: e.title,
    amount: Number(e.amount) || 0,
    paidByYou: e.paid_by === userId,
    createdAt: e.created_at,
  }));

  return {
    youOwe: round2(youOwe),
    youAreOwed: round2(youAreOwed),
    expensesInvolved: allIds.length,
    recent,
  };
}

export async function fetchSeriesFinanceSettings(
  seriesId: string
): Promise<import('@/lib/types').SeriesFinanceSettings | null> {
  const { data, error } = await supabase
    .from('series_finance_settings')
    .select('*')
    .eq('series_id', seriesId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as import('@/lib/types').SeriesFinanceSettings;
  // Legacy who_pays → selected
  const who =
    row.who_pays === 'group'
      ? 'group'
      : ('selected' as import('@/lib/types').FinanceWhoPays);
  const payerIds = await fetchSeriesFinancePayerIds(seriesId);
  return { ...row, who_pays: who, payer_ids: payerIds };
}

export async function fetchSeriesFinancePayerIds(seriesId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('series_finance_payers')
    .select('user_id')
    .eq('series_id', seriesId);
  if (error) {
    if (/relation|does not exist/i.test(error.message)) return [];
    throw error;
  }
  return (data ?? []).map((r: { user_id: string }) => r.user_id);
}

export async function replaceSeriesFinancePayers(
  seriesId: string,
  userIds: string[]
): Promise<void> {
  const { error: delErr } = await supabase
    .from('series_finance_payers')
    .delete()
    .eq('series_id', seriesId);
  if (delErr && !/relation|does not exist/i.test(delErr.message)) throw delErr;

  const unique = Array.from(new Set(userIds.filter(Boolean)));
  if (!unique.length) return;
  const { error } = await supabase.from('series_finance_payers').insert(
    unique.map((user_id) => ({ series_id: seriesId, user_id }))
  );
  if (error) throw error;
}

export async function resolveEligiblePayerIds(
  settings: import('@/lib/types').SeriesFinanceSettings
): Promise<string[]> {
  if (settings.who_pays === 'group' && settings.payer_group_id) {
    const { data, error } = await supabase
      .from('friend_group_members')
      .select('user_id')
      .eq('group_id', settings.payer_group_id);
    if (error) throw error;
    return Array.from(new Set((data ?? []).map((r: { user_id: string }) => r.user_id)));
  }
  if (settings.payer_ids?.length) return Array.from(new Set(settings.payer_ids));
  return fetchSeriesFinancePayerIds(settings.series_id);
}

export async function upsertSeriesFinanceSettings(input: {
  seriesId: string;
  fundingMode: import('@/lib/types').FundingMode;
  amount: number;
  whoPays?: import('@/lib/types').FinanceWhoPays;
  payerGroupId?: string | null;
  payerIds?: string[];
  userId: string;
}): Promise<void> {
  const who: import('@/lib/types').FinanceWhoPays =
    input.whoPays === 'group' ? 'group' : 'selected';
  const { error } = await supabase.from('series_finance_settings').upsert(
    {
      series_id: input.seriesId,
      funding_mode: input.fundingMode,
      amount: input.amount,
      who_pays: who,
      payer_group_id: who === 'group' ? input.payerGroupId ?? null : null,
      currency: 'EUR',
      updated_by: input.userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'series_id' }
  );
  if (error) throw error;

  if (who === 'selected') {
    await replaceSeriesFinancePayers(input.seriesId, input.payerIds ?? []);
  } else {
    await replaceSeriesFinancePayers(input.seriesId, []);
  }
}

export async function clearSeriesFinanceSettings(seriesId: string): Promise<void> {
  const { error } = await supabase.from('series_finance_settings').delete().eq('series_id', seriesId);
  if (error && !/does not exist|permission/i.test(error.message)) throw error;
}

function monthKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function feePeriodKey(input: {
  mode: string;
  activityId: string;
  startsAt: string;
  userId: string;
}): string {
  if (input.mode === 'monthly') {
    return `fee:month:${monthKey(input.startsAt)}:user:${input.userId}`;
  }
  if (input.mode === 'fixed') {
    return `fee:fixed:user:${input.userId}`;
  }
  return `fee:event:${input.activityId}:user:${input.userId}`;
}

export function monthlyFeePeriodKey(month: string, userId: string): string {
  return `fee:month:${month}:user:${userId}`;
}

/** Parse `fee:month:YYYY-MM:user:uuid` → { month, userId }. */
export function parseMonthlyFeeKey(
  periodKey: string | null | undefined
): { month: string; userId: string } | null {
  if (!periodKey) return null;
  const m = periodKey.match(/^fee:month:(\d{4}-\d{2}):user:([0-9a-f-]{36})$/i);
  if (!m) return null;
  return { month: m[1], userId: m[2] };
}

function monthsInclusive(fromMonth: string, toMonth: string): string[] {
  const [fy, fm] = fromMonth.split('-').map(Number);
  const [ty, tm] = toMonth.split('-').map(Number);
  if (!fy || !fm || !ty || !tm) return [];
  const out: string[] = [];
  let y = fy;
  let mo = fm;
  while (y < ty || (y === ty && mo <= tm)) {
    out.push(`${y}-${String(mo).padStart(2, '0')}`);
    mo += 1;
    if (mo > 12) {
      mo = 1;
      y += 1;
    }
    if (out.length > 120) break;
  }
  return out;
}

function maxMonth(a: string, b: string): string {
  return a >= b ? a : b;
}

/** Everyone who has joined any occurrence in the series at least once. */
export async function fetchSeriesAttendeeIds(seriesId: string): Promise<string[]> {
  const { data: acts } = await supabase
    .from('activities')
    .select('id')
    .or(`id.eq.${seriesId},series_id.eq.${seriesId}`);
  const ids = (acts ?? []).map((a: { id: string }) => a.id);
  if (!ids.length) return [];
  const { data: joins } = await supabase
    .from('activity_joins')
    .select('user_id')
    .in('activity_id', ids);
  return Array.from(new Set((joins ?? []).map((j: { user_id: string }) => j.user_id)));
}

type MonthlyBillingRow = {
  series_id: string;
  user_id: string;
  started_month: string;
  stopped: boolean;
};

async function fetchMonthlyBilling(seriesId: string): Promise<MonthlyBillingRow[]> {
  const { data, error } = await supabase
    .from('series_finance_monthly_billing')
    .select('series_id, user_id, started_month, stopped')
    .eq('series_id', seriesId);
  if (error) {
    if (/relation|does not exist/i.test(error.message)) return [];
    throw error;
  }
  return (data as MonthlyBillingRow[]) ?? [];
}

async function fetchMonthlySkips(seriesId: string): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('series_finance_monthly_skips')
    .select('user_id, month_key')
    .eq('series_id', seriesId);
  if (error) {
    if (/relation|does not exist/i.test(error.message)) return new Set();
    throw error;
  }
  return new Set(
    (data ?? []).map((r: { user_id: string; month_key: string }) => `${r.user_id}:${r.month_key}`)
  );
}

/** Earliest activity month this user joined in the series (YYYY-MM). */
async function fetchFirstAttendanceMonth(
  seriesId: string,
  userId: string
): Promise<string | null> {
  const { data: acts } = await supabase
    .from('activities')
    .select('id, starts_at')
    .or(`id.eq.${seriesId},series_id.eq.${seriesId}`);
  const actRows = (acts ?? []) as { id: string; starts_at: string }[];
  if (!actRows.length) return null;
  const byId = new Map(actRows.map((a) => [a.id, a.starts_at]));
  const { data: joins } = await supabase
    .from('activity_joins')
    .select('activity_id')
    .eq('user_id', userId)
    .in(
      'activity_id',
      actRows.map((a) => a.id)
    );
  let earliest: string | null = null;
  for (const j of joins ?? []) {
    const starts = byId.get((j as { activity_id: string }).activity_id);
    if (!starts) continue;
    const mk = monthKey(starts);
    if (!earliest || mk < earliest) earliest = mk;
  }
  return earliest;
}

/** Start monthly billing on first attendance (idempotent). */
export async function ensureMonthlyBillingStarted(
  seriesId: string,
  userId: string,
  startedMonth: string
): Promise<void> {
  const { data: existing } = await supabase
    .from('series_finance_monthly_billing')
    .select('user_id')
    .eq('series_id', seriesId)
    .eq('user_id', userId)
    .maybeSingle();
  if (existing) return;
  const first = (await fetchFirstAttendanceMonth(seriesId, userId)) ?? startedMonth;
  const { error } = await supabase.from('series_finance_monthly_billing').insert({
    series_id: seriesId,
    user_id: userId,
    started_month: first,
    stopped: false,
  });
  if (error && error.code !== '23505') throw error;
}

async function createPersonFee(input: {
  seriesId: string;
  organizerId: string;
  userId: string;
  perPerson: number;
  mode: string;
  activityId: string;
  title: string;
  startsAt: string;
  periodKey: string;
}): Promise<void> {
  let expenseType: ActivityExpense['expense_type'] = 'per_event';
  let expenseTitle: string;
  let activityId: string | null = input.activityId;
  if (input.mode === 'monthly') {
    const mk = parseMonthlyFeeKey(input.periodKey)?.month ?? monthKey(input.startsAt);
    expenseType = 'monthly';
    expenseTitle = `Fee · ${input.perPerson.toFixed(2)} € · ${mk}`;
    activityId = null;
  } else if (input.mode === 'fixed') {
    expenseType = 'annual';
    expenseTitle = `Fixed fee · ${input.perPerson.toFixed(2)} €`;
    activityId = null;
  } else {
    expenseTitle = `Event fee · ${input.perPerson.toFixed(2)} € · ${input.title}`;
  }
  await createExpense({
    seriesId: input.seriesId,
    expenseType,
    title: expenseTitle,
    amount: input.perPerson,
    splitMode: 'selected',
    memberIds: [input.userId],
    paidBy: input.organizerId,
    activityId,
    periodKey: input.periodKey,
  });
}

/**
 * Remove a monthly fee.
 * - this_month: delete expense + skip this month (future months still charged)
 * - stop_future: delete expense + stop all further monthly auto-charges
 */
export async function removeMonthlyFundingFee(input: {
  seriesId: string;
  expenseId: string;
  periodKey: string;
  mode: 'this_month' | 'stop_future';
}): Promise<void> {
  const parsed = parseMonthlyFeeKey(input.periodKey);
  if (!parsed) {
    await deleteExpense(input.expenseId);
    return;
  }
  await deleteExpense(input.expenseId);
  if (input.mode === 'this_month') {
    const { error } = await supabase.from('series_finance_monthly_skips').upsert(
      {
        series_id: input.seriesId,
        user_id: parsed.userId,
        month_key: parsed.month,
      },
      { onConflict: 'series_id,user_id,month_key' }
    );
    if (error && !/relation|does not exist/i.test(error.message)) throw error;
    return;
  }
  const { error } = await supabase
    .from('series_finance_monthly_billing')
    .update({ stopped: true, updated_at: new Date().toISOString() })
    .eq('series_id', input.seriesId)
    .eq('user_id', parsed.userId);
  if (error && !/relation|does not exist/i.test(error.message)) throw error;
}

/**
 * Create per-person funding fees for eligible people who have attended
 * (idempotent). Does not overwrite manually edited existing fees.
 * - per_event: charge when they join this occurrence
 * - monthly: start on first attendance, then every calendar month (even without attendance)
 * - fixed: charge on first join anywhere in the series
 */
export async function syncAttendeeFundingFees(input: {
  activity: {
    id: string;
    series_id?: string | null;
    created_by: string;
    finance_enabled?: boolean;
    title: string;
    starts_at: string;
  };
  settings: import('@/lib/types').SeriesFinanceSettings;
  /** If set, only consider this user (e.g. right after they join). */
  onlyUserId?: string;
}): Promise<{ created: number; total: number; perPerson: number; payerCount: number }> {
  const perPerson = round2(Number(input.settings.amount) || 0);
  const empty = { created: 0, total: 0, perPerson, payerCount: 0 };
  if (!input.activity.finance_enabled || perPerson <= 0) return empty;

  const sid = seriesKey(input.activity);
  const organizerId = input.activity.created_by;
  const mode =
    input.settings.funding_mode === 'annual' ? 'fixed' : input.settings.funding_mode;

  const eligible = (await resolveEligiblePayerIds({ ...input.settings, series_id: sid })).filter(
    (id) => id !== organizerId
  );
  if (!eligible.length) return empty;

  const existing = await fetchSeriesExpenses(sid);
  const existingKeys = new Set(existing.map((e) => e.period_key).filter(Boolean) as string[]);
  let created = 0;

  if (mode === 'monthly') {
    const attendees = await fetchSeriesAttendeeIds(sid);
    const attendeeSet = new Set(attendees);
    const startMonth = monthKey(input.activity.starts_at);
    const throughMonth = maxMonth(startMonth, monthKey(new Date().toISOString()));

    let toStart = eligible.filter((id) => attendeeSet.has(id));
    if (input.onlyUserId) {
      toStart = toStart.filter((id) => id === input.onlyUserId);
    }
    for (const userId of toStart) {
      await ensureMonthlyBillingStarted(sid, userId, startMonth);
    }

    const [billing, skips] = await Promise.all([
      fetchMonthlyBilling(sid),
      fetchMonthlySkips(sid),
    ]);
    let active = billing.filter((b) => !b.stopped && eligible.includes(b.user_id));
    if (input.onlyUserId) {
      active = active.filter((b) => b.user_id === input.onlyUserId);
    }

    for (const row of active) {
      const months = monthsInclusive(row.started_month, throughMonth);
      for (const mk of months) {
        if (skips.has(`${row.user_id}:${mk}`)) continue;
        const periodKey = monthlyFeePeriodKey(mk, row.user_id);
        if (existingKeys.has(periodKey)) continue;
        await createPersonFee({
          seriesId: sid,
          organizerId,
          userId: row.user_id,
          perPerson,
          mode: 'monthly',
          activityId: input.activity.id,
          title: input.activity.title,
          startsAt: `${mk}-01T12:00:00.000Z`,
          periodKey,
        });
        existingKeys.add(periodKey);
        created += 1;
      }
    }
  } else {
    let attendees: string[];
    if (mode === 'fixed') {
      attendees = await fetchSeriesAttendeeIds(sid);
    } else {
      attendees = await fetchActivityAttendeeIds(input.activity.id);
    }

    const attendeeSet = new Set(attendees);
    let chargeable = eligible.filter((id) => attendeeSet.has(id));
    if (input.onlyUserId) {
      chargeable = chargeable.filter((id) => id === input.onlyUserId);
    }

    for (const userId of chargeable) {
      const periodKey = feePeriodKey({
        mode,
        activityId: input.activity.id,
        startsAt: input.activity.starts_at,
        userId,
      });
      if (existingKeys.has(periodKey)) continue;
      await createPersonFee({
        seriesId: sid,
        organizerId,
        userId,
        perPerson,
        mode,
        activityId: input.activity.id,
        title: input.activity.title,
        startsAt: input.activity.starts_at,
        periodKey,
      });
      existingKeys.add(periodKey);
      created += 1;
    }
  }

  const feeExpenses = (await fetchSeriesExpenses(sid)).filter(
    (e) => (e.period_key ?? '').startsWith('fee:')
  );
  const total = round2(feeExpenses.reduce((s, e) => s + (Number(e.amount) || 0), 0));
  const payerCount = new Set(
    feeExpenses.map((e) => fundingFeeUserId(e.period_key)).filter(Boolean)
  ).size;

  return { created, total, perPerson, payerCount };
}

/** @deprecated alias — fees sync on attendance */
export async function ensureFundingExpenses(input: {
  activity: {
    id: string;
    series_id?: string | null;
    created_by: string;
    finance_enabled?: boolean;
    title: string;
    starts_at: string;
  };
  settings: import('@/lib/types').SeriesFinanceSettings;
}): Promise<{ created: boolean; total: number; perPerson: number; payerCount: number }> {
  const r = await syncAttendeeFundingFees(input);
  return { created: r.created > 0, total: r.total, perPerson: r.perPerson, payerCount: r.payerCount };
}

/** Manually create a fee for an eligible person (organizer override). */
export async function createManualFundingFee(input: {
  activity: {
    id: string;
    series_id?: string | null;
    created_by: string;
    finance_enabled?: boolean;
    title: string;
    starts_at: string;
  };
  settings: import('@/lib/types').SeriesFinanceSettings;
  userId: string;
  amount?: number;
}): Promise<void> {
  const perPerson = round2(
    input.amount != null ? Number(input.amount) : Number(input.settings.amount) || 0
  );
  if (perPerson <= 0) throw new Error('Invalid amount');
  const sid = seriesKey(input.activity);
  const mode =
    input.settings.funding_mode === 'annual' ? 'fixed' : input.settings.funding_mode;
  const periodKey = feePeriodKey({
    mode,
    activityId: input.activity.id,
    startsAt: input.activity.starts_at,
    userId: input.userId,
  });
  const existing = await fetchSeriesExpenses(sid);
  const found = existing.find((e) => e.period_key === periodKey);
  if (found) {
    await updateExpenseAmount(found.id, perPerson);
    return;
  }
  let expenseType: ActivityExpense['expense_type'] = 'per_event';
  let title: string;
  let activityId: string | null = input.activity.id;
  if (mode === 'monthly') {
    expenseType = 'monthly';
    title = `Fee · ${perPerson.toFixed(2)} € · ${monthKey(input.activity.starts_at)}`;
    activityId = null;
  } else if (mode === 'fixed') {
    expenseType = 'annual';
    title = `Fixed fee · ${perPerson.toFixed(2)} €`;
    activityId = null;
  } else {
    title = `Event fee · ${perPerson.toFixed(2)} € · ${input.activity.title}`;
  }
  await createExpense({
    seriesId: sid,
    expenseType,
    title,
    amount: perPerson,
    splitMode: 'selected',
    memberIds: [input.userId],
    paidBy: input.activity.created_by,
    activityId,
    periodKey,
  });
}
