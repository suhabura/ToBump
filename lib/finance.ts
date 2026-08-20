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
  paidBy: string;
  activityId?: string | null;
  periodKey?: string | null;
  dueDate?: string | null;
}): Promise<string> {
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
    p_paid_by: input.paidBy,
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
