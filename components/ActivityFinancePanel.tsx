import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { Button, Chip, Input, Muted, Subtitle } from '@/components/ui';
import {
  EXPENSE_CATEGORIES,
  computeLedgerBudget,
  computeOpenObligations,
  createExpense,
  createManualFundingFee,
  fetchSeriesFinanceSettings,
  fetchSeriesJoinsWithSessions,
  fetchSeriesLedger,
  fetchSeriesMemberFinanceSettings,
  fetchSeriesMemberProfiles,
  fetchSeriesObligations,
  fetchSeriesExpenses,
  fetchSeriesInviteeIds,
  isActualExpense,
  isFundingExpense,
  recordPersonPayment,
  resolveEligiblePayerIds,
  resolveMemberFinance,
  seriesKey,
  syncAttendeeFundingFees,
  upsertMemberFinanceSettings,
  withOrganizerAndEditors,
  fetchSeriesEditorIds,
  type ExpenseWithMeta,
  type SeriesJoinRow,
} from '@/lib/finance';
import { supabase } from '@/lib/supabase';
import type {
  ActivityObligation,
  ActivityWithRelations,
  FundingMode,
  Profile,
  SeriesFinanceLedgerEntry,
  SeriesFinanceMemberSettings,
  SeriesFinanceSettings,
} from '@/lib/types';
import { displayName } from '@/lib/types';
import {
  fetchSeriesGuestDebts,
  setGuestAttendancePaid,
  type GuestDebtRow,
} from '@/lib/guests';
import { useT } from '@/i18n';
import { theme } from '@/constants/theme';

type Props = {
  activity: ActivityWithRelations;
  userId: string;
  canManage: boolean;
  attendees: Profile[];
};

type Tab = 'overview' | 'transactions' | 'expense';
type PersonFilter = 'all' | 'unpaid' | 'partial' | 'paid';

type PersonRow = {
  userId: string;
  mode: FundingMode;
  amount: number;
  visits: number;
  due: number;
  paid: number;
  open: number;
  status: 'paid' | 'partial' | 'unpaid' | 'none' | 'waiting';
};

function modeLabel(mode: FundingMode, t: ReturnType<typeof useT>): string {
  if (mode === 'monthly') return t.form.payMonthly;
  if (mode === 'fixed' || mode === 'annual') return t.form.payFixed;
  return t.form.payPerEvent;
}

function categoryLabel(cat: string | null | undefined, t: ReturnType<typeof useT>): string {
  switch (cat) {
    case 'equipment':
      return t.finance.catEquipment;
    case 'venue':
      return t.finance.catVenue;
    case 'referees':
      return t.finance.catReferees;
    case 'transport':
      return t.finance.catTransport;
    case 'food':
      return t.finance.catFood;
    default:
      return t.finance.catOther;
  }
}

function formatDate(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString();
}

function formatEuro(n: number): string {
  return `${n.toFixed(2)} €`;
}

function personChargeLines(row: PersonRow, t: ReturnType<typeof useT>): string[] {
  const lines = [t.finance.visitsCount(row.visits)];
  if (row.mode === 'per_event') {
    lines.push(`${t.finance.pricePerVisit}: ${formatEuro(row.amount)}`);
    lines.push(`${t.finance.dueTogether}: ${formatEuro(row.due)}`);
  } else if (row.mode === 'fixed' || row.mode === 'annual') {
    lines.push(`${t.finance.oneTimeFee}: ${formatEuro(row.amount)}`);
    if (Math.abs(row.due - row.amount) > 0.01) {
      lines.push(`${t.finance.dueTogether}: ${formatEuro(row.due)}`);
    }
  } else {
    lines.push(`${modeLabel(row.mode, t)} · ${formatEuro(row.amount)}`);
    if (row.due > 0.001) lines.push(`${t.finance.dueTogether}: ${formatEuro(row.due)}`);
  }
  return lines;
}

function errorMessage(e: unknown, fallback: string): string {
  if (e instanceof Error && e.message) return e.message;
  if (e && typeof e === 'object' && 'message' in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === 'string' && m.trim()) return m;
  }
  if (typeof e === 'string' && e.trim()) return e;
  return fallback;
}

export function ActivityFinancePanel({ activity, userId, canManage, attendees }: Props) {
  const t = useT();
  const sid = seriesKey(activity);
  const [tab, setTab] = useState<Tab>('overview');
  const [personFilter, setPersonFilter] = useState<PersonFilter>('all');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [financeSettings, setFinanceSettings] = useState<SeriesFinanceSettings | null>(null);
  const [memberOverrides, setMemberOverrides] = useState<SeriesFinanceMemberSettings[]>([]);
  const [obligations, setObligations] = useState<ActivityObligation[]>([]);
  const [expenses, setExpenses] = useState<ExpenseWithMeta[]>([]);
  const [ledger, setLedger] = useState<SeriesFinanceLedgerEntry[]>([]);
  const [joins, setJoins] = useState<SeriesJoinRow[]>([]);
  const [members, setMembers] = useState<Profile[]>([]);
  const [, setEligibleIds] = useState<string[]>([]);
  const [guestDebts, setGuestDebts] = useState<GuestDebtRow[]>([]);

  const [detailUserId, setDetailUserId] = useState<string | null>(null);
  const [payAmount, setPayAmount] = useState('');
  const [payNote, setPayNote] = useState('');
  const [editing, setEditing] = useState(false);
  const [editMode, setEditMode] = useState<FundingMode>('per_event');
  const [editAmount, setEditAmount] = useState('');

  const [expTitle, setExpTitle] = useState('');
  const [expAmount, setExpAmount] = useState('');
  const [expCategory, setExpCategory] = useState<(typeof EXPENSE_CATEGORIES)[number]>('other');

  const profilesById = useMemo(() => {
    const map = new Map(members.map((m) => [m.id, m]));
    for (const a of attendees) map.set(a.id, a);
    return map;
  }, [members, attendees]);

  const overrideMap = useMemo(
    () => new Map(memberOverrides.map((r) => [r.user_id, r])),
    [memberOverrides]
  );

  const budget = useMemo(() => computeLedgerBudget(ledger), [ledger]);
  const unpaidMembers = useMemo(() => computeOpenObligations(obligations), [obligations]);
  const unpaidGuests = useMemo(
    () => guestDebts.reduce((s, g) => s + (g.status === 'unpaid' ? g.open : 0), 0),
    [guestDebts]
  );
  const unpaidTotal = Math.round((unpaidMembers + unpaidGuests) * 100) / 100;

  const visitsByUser = useMemo(() => {
    const map = new Map<string, number>();
    for (const j of joins) {
      map.set(j.user_id, (map.get(j.user_id) ?? 0) + 1);
    }
    return map;
  }, [joins]);

  const personRows = useMemo((): PersonRow[] => {
    if (!financeSettings) return [];
    const ids = new Set<string>();
    for (const id of visitsByUser.keys()) ids.add(id);
    for (const o of obligations) ids.add(o.user_id);

    const feeExpenseIds = new Set(
      expenses.filter((e) => isFundingExpense(e)).map((e) => e.id)
    );

    const rows: PersonRow[] = [];
    for (const uid of ids) {
      if (!uid) continue;
      const { mode, amount } = resolveMemberFinance(financeSettings, overrideMap, uid);
      const personObls = obligations.filter(
        (o) => o.user_id === uid && feeExpenseIds.has(o.expense_id)
      );
      const due = personObls.reduce((s, o) => s + (Number(o.amount_due) || 0), 0);
      const paid = personObls.reduce((s, o) => s + (Number(o.amount_paid) || 0), 0);
      const open = Math.max(0, due - paid);
      const visits = visitsByUser.get(uid) ?? 0;
      if (visits <= 0 && due <= 0.001) continue;
      let status: PersonRow['status'] = 'unpaid';
      if (due > 0.001) {
        if (open <= 0.001) status = 'paid';
        else if (paid > 0.001) status = 'partial';
        else status = 'unpaid';
      } else if (visits > 0) {
        status = 'none';
      }
      rows.push({
        userId: uid,
        mode,
        amount,
        visits,
        due: Math.round(due * 100) / 100,
        paid: Math.round(paid * 100) / 100,
        open: Math.round(open * 100) / 100,
        status,
      });
    }
    rows.sort((a, b) => {
      const order = { unpaid: 0, partial: 1, none: 2, waiting: 3, paid: 4 };
      if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
      return displayName(profilesById.get(a.userId) ?? null).localeCompare(
        displayName(profilesById.get(b.userId) ?? null)
      );
    });
    return rows;
  }, [
    financeSettings,
    visitsByUser,
    obligations,
    expenses,
    overrideMap,
    profilesById,
  ]);

  const filterCounts = useMemo(
    () => ({
      all: personRows.length,
      unpaid: personRows.filter((r) => r.status === 'unpaid').length,
      partial: personRows.filter((r) => r.status === 'partial').length,
      paid: personRows.filter((r) => r.status === 'paid').length,
    }),
    [personRows]
  );

  const visiblePersonRows = useMemo(() => {
    if (personFilter === 'all') return personRows;
    return personRows.filter((r) => r.status === personFilter);
  }, [personRows, personFilter]);

  const summary = useMemo(() => {
    const toCollect =
      obligations.reduce(
        (s, o) => s + (o.status === 'waived' ? 0 : Number(o.amount_due) || 0),
        0
      ) + guestDebts.reduce((s, g) => s + (Number(g.amount) || 0), 0);
    return {
      toCollect: Math.round(toCollect * 100) / 100,
      collected: budget.received,
      open: unpaidTotal,
      costs: budget.spent,
      balance: budget.available,
    };
  }, [obligations, guestDebts, budget, unpaidTotal]);

  const hasAnyActivity =
    joins.length > 0 || obligations.length > 0 || ledger.length > 0 || guestDebts.length > 0;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let settings: SeriesFinanceSettings | null = null;
      try {
        settings = await fetchSeriesFinanceSettings(sid);
        setFinanceSettings(settings);
        if (settings && activity.finance_enabled) {
          try {
            await syncAttendeeFundingFees({ activity, settings });
          } catch {
            /* fee sync is best-effort; panel should still open */
          }
          try {
            const [eligible, editorIds] = await Promise.all([
              resolveEligiblePayerIds(settings),
              fetchSeriesEditorIds(sid),
            ]);
            setEligibleIds(withOrganizerAndEditors(eligible, activity.created_by, editorIds));
          } catch {
            setEligibleIds(
              withOrganizerAndEditors(settings.payer_ids ?? [], activity.created_by)
            );
          }
          try {
            setMemberOverrides(await fetchSeriesMemberFinanceSettings(sid));
          } catch {
            setMemberOverrides([]);
          }
        } else {
          setEligibleIds([]);
          setMemberOverrides([]);
        }
      } catch {
        setFinanceSettings(null);
        setEligibleIds([]);
        setMemberOverrides([]);
      }

      const settled = await Promise.allSettled([
        fetchSeriesExpenses(sid),
        fetchSeriesObligations(sid),
        fetchSeriesLedger(sid),
        fetchSeriesMemberProfiles(sid),
        fetchSeriesJoinsWithSessions(sid),
        fetchSeriesInviteeIds(sid),
        fetchSeriesGuestDebts(sid),
      ]);

      const exps = settled[0].status === 'fulfilled' ? settled[0].value : [];
      const obls = settled[1].status === 'fulfilled' ? settled[1].value : [];
      const led = settled[2].status === 'fulfilled' ? settled[2].value : [];
      const mems = settled[3].status === 'fulfilled' ? settled[3].value : [];
      const jns = settled[4].status === 'fulfilled' ? settled[4].value : [];
      const inviteIds = settled[5].status === 'fulfilled' ? settled[5].value : [];
      const guests = settled[6].status === 'fulfilled' ? settled[6].value : [];
      setGuestDebts(guests);

      // Soft-load: keep the card usable. Schema is deployed; don't show migration banners.
      const otherFail = settled.find((r) => r.status === 'rejected');
      if (otherFail && otherFail.status === 'rejected') {
        const msg = errorMessage(otherFail.reason, '');
        if (
          msg &&
          !/jwt|not authenticated|permission|rls|schema cache|does not exist|could not find/i.test(
            msg
          )
        ) {
          setError(msg);
        }
      }

      setExpenses(exps);
      setObligations(obls);
      setLedger(led);
      setJoins(jns);

      // Attendees always show in finance (FoF / walk-ins), not only preselected payers
      if (activity.finance_enabled) {
        setEligibleIds((prev) =>
          withOrganizerAndEditors(
            [...prev, ...jns.map((j) => j.user_id), ...inviteIds],
            activity.created_by
          )
        );
      }

      // If finance is on but settings row missing, use activity defaults so the card is usable
      if (!settings && activity.finance_enabled) {
        const fallback: SeriesFinanceSettings = {
          series_id: sid,
          funding_mode: 'per_event',
          amount: Number(activity.price) || 0,
          currency: 'EUR',
          who_pays: 'selected',
          payer_group_id: null,
          payer_ids: withOrganizerAndEditors(
            [...inviteIds, ...(activity.series_invite_user_ids ?? [])],
            activity.created_by
          ),
          updated_by: null,
          updated_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        };
        settings = fallback;
        setFinanceSettings(fallback);
      }

      const needProfileIds = Array.from(
        new Set([
          ...mems.map((m) => m.id),
          ...attendees.map((a) => a.id),
          ...jns.map((j) => j.user_id),
          ...obls.map((o) => o.user_id),
          ...exps.map((e) => e.created_by).filter(Boolean),
          ...led.flatMap((l) => [l.user_id, l.created_by].filter(Boolean) as string[]),
          ...inviteIds,
          ...(settings?.payer_ids ?? []),
          ...(activity.series_invite_user_ids ?? []),
        ])
      );
      let people = mems.length ? [...mems] : [...attendees];
      const have = new Set(people.map((p) => p.id));
      const missing = needProfileIds.filter((id) => id && !have.has(id));
      if (missing.length) {
        try {
          const { data: extra } = await supabase
            .from('profiles')
            .select('id, first_name, last_name, email')
            .in('id', missing);
          if (extra?.length) people = [...people, ...(extra as Profile[])];
        } catch {
          /* ignore profile enrich failures */
        }
      }
      setMembers(people);

      if (settings && activity.finance_enabled) {
        try {
          const [eligible, editorIds] = await Promise.all([
            resolveEligiblePayerIds(settings),
            fetchSeriesEditorIds(sid),
          ]);
          setEligibleIds(
            withOrganizerAndEditors(
              [...eligible, ...inviteIds, ...(settings.payer_ids ?? [])],
              activity.created_by,
              editorIds
            )
          );
        } catch {
          setEligibleIds(
            withOrganizerAndEditors(
              [...(settings.payer_ids ?? []), ...inviteIds, ...(activity.series_invite_user_ids ?? [])],
              activity.created_by
            )
          );
        }
      }
    } catch (e) {
      setError(errorMessage(e, t.common.error));
    } finally {
      setLoading(false);
    }
  }, [activity, attendees, sid, t.common.error]);

  useEffect(() => {
    void load();
  }, [load]);

  const detailRow = personRows.find((r) => r.userId === detailUserId) ?? null;
  const detailJoins = useMemo(
    () =>
      joins
        .filter((j) => j.user_id === detailUserId)
        .sort((a, b) => (a.starts_at ?? '').localeCompare(b.starts_at ?? '')),
    [joins, detailUserId]
  );
  const detailLedger = useMemo(
    () => ledger.filter((l) => l.user_id === detailUserId),
    [ledger, detailUserId]
  );
  const oblById = useMemo(() => {
    const map = new Map(obligations.map((o) => [o.id, o]));
    return map;
  }, [obligations]);

  async function onRecordPayment() {
    if (!canManage || !detailUserId) return;
    const n = Number(payAmount.replace(',', '.'));
    if (!Number.isFinite(n) || n <= 0) {
      Alert.alert(t.common.error, t.finance.needAmount);
      return;
    }
    const open = personRows.find((r) => r.userId === detailUserId)?.open ?? 0;
    if (n > open + 0.01) {
      Alert.alert(t.common.error, t.finance.paymentExceedsOpen);
      return;
    }
    setBusy(true);
    try {
      await recordPersonPayment({
        seriesId: sid,
        userId: detailUserId,
        amount: n,
        note: payNote.trim() || null,
        activityId: activity.id,
      });
      setPayAmount('');
      setPayNote('');
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      Alert.alert(
        t.common.error,
        /exceeds open debt/i.test(msg) ? t.finance.paymentExceedsOpen : msg || t.common.error
      );
    } finally {
      setBusy(false);
    }
  }

  async function onSaveSettings() {
    if (!canManage || !detailUserId || !financeSettings) return;
    const n = Number(editAmount.replace(',', '.'));
    if (!Number.isFinite(n) || n < 0) {
      Alert.alert(t.common.error, t.finance.needAmount);
      return;
    }
    setBusy(true);
    try {
      await upsertMemberFinanceSettings({
        seriesId: sid,
        userId: detailUserId,
        fundingMode: editMode,
        amount: n,
        updatedBy: userId,
        activity,
        settings: financeSettings,
      });
      setEditing(false);
      await load();
    } catch (e) {
      Alert.alert(t.common.error, e instanceof Error ? e.message : t.common.error);
    } finally {
      setBusy(false);
    }
  }

  async function onChargeIfNeeded() {
    if (!canManage || !detailUserId || !financeSettings) return;
    setBusy(true);
    try {
      const { amount } = resolveMemberFinance(financeSettings, overrideMap, detailUserId);
      await createManualFundingFee({
        activity,
        settings: financeSettings,
        userId: detailUserId,
        amount,
      });
      await load();
    } catch (e) {
      Alert.alert(t.common.error, e instanceof Error ? e.message : t.common.error);
    } finally {
      setBusy(false);
    }
  }

  async function onToggleGuestPaid(guest: GuestDebtRow, paid: boolean) {
    if (!canManage) return;
    setBusy(true);
    try {
      await setGuestAttendancePaid(guest.attendanceId, paid);
      await load();
    } catch (e) {
      Alert.alert(t.common.error, e instanceof Error ? e.message : t.common.error);
    } finally {
      setBusy(false);
    }
  }

  async function onAddExpense() {
    if (!canManage) return;
    const n = Number(expAmount.replace(',', '.'));
    if (!expTitle.trim()) {
      Alert.alert(t.common.error, t.finance.needTitle);
      return;
    }
    if (!Number.isFinite(n) || n <= 0) {
      Alert.alert(t.common.error, t.finance.needAmount);
      return;
    }
    setBusy(true);
    try {
      await createExpense({
        seriesId: sid,
        title: expTitle.trim(),
        amount: n,
        splitMode: 'selected',
        memberIds: [activity.created_by],
        paidFromBudget: true,
        activityId: activity.id,
        category: expCategory,
      });
      setExpTitle('');
      setExpAmount('');
      setExpCategory('other');
      setTab('transactions');
      await load();
    } catch (e) {
      Alert.alert(t.common.error, e instanceof Error ? e.message : t.common.error);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Muted>{t.common.loading}</Muted>;

  return (
    <View style={{ gap: 12 }}>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.tabRow}>
        <Chip
          label={t.finance.overviewTab}
          active={tab === 'overview'}
          onPress={() => setTab('overview')}
        />
        <Chip
          label={t.finance.allTransactions}
          active={tab === 'transactions'}
          onPress={() => setTab('transactions')}
        />
        {canManage ? (
          <Chip
            label={t.finance.addExpenseAction}
            active={tab === 'expense'}
            onPress={() => setTab('expense')}
          />
        ) : null}
      </View>

      {!canManage ? <Muted>{t.finance.viewOnly}</Muted> : null}

      {tab === 'overview' ? (
        <View style={{ gap: 12 }}>
          {financeSettings ? (
            <View style={styles.card}>
              <Muted>{t.finance.paymentMethod}</Muted>
              <Text style={styles.infoTitle}>
                {financeSettings.funding_mode === 'fixed' || financeSettings.funding_mode === 'annual'
                  ? t.finance.payFixedTitle
                  : financeSettings.funding_mode === 'monthly'
                    ? t.form.payMonthly
                    : t.finance.payPerEventTitle}
              </Text>
              <Text style={styles.amountLine}>
                {financeSettings.funding_mode === 'fixed' || financeSettings.funding_mode === 'annual'
                  ? `${formatEuro(Number(financeSettings.amount) || 0)} / ${t.finance.perPersonUnit}`
                  : financeSettings.funding_mode === 'monthly'
                    ? formatEuro(Number(financeSettings.amount) || 0)
                    : `${formatEuro(Number(financeSettings.amount) || 0)} / ${t.finance.perEventUnit}`}
              </Text>
              {activity.is_recurring &&
              (financeSettings.funding_mode === 'fixed' || financeSettings.funding_mode === 'annual') ? (
                <Muted>{t.finance.forWholeSeries}</Muted>
              ) : null}
            </View>
          ) : null}

          <View style={styles.summaryRow}>
            <SummaryCard label={t.finance.toCollect} value={formatEuro(summary.toCollect)} />
            <SummaryCard label={t.finance.collected} value={formatEuro(summary.collected)} />
          </View>
          <View style={styles.summaryRow}>
            <SummaryCard label={t.finance.openBalance} value={formatEuro(summary.open)} />
            <SummaryCard label={t.finance.costs} value={formatEuro(summary.costs)} />
          </View>
          <View style={styles.summaryRow}>
            <SummaryCard label={t.finance.balance} value={formatEuro(summary.balance)} emphasize />
          </View>

          {!hasAnyActivity ? (
            <View style={styles.infoCard}>
              <Text style={styles.infoTitle}>{t.finance.beforeFirstTitle}</Text>
              <Muted>{t.finance.beforeFirstBody}</Muted>
            </View>
          ) : null}

          <View style={styles.card}>
            <Subtitle>{t.finance.participants}</Subtitle>
            <Muted>
              {!hasAnyActivity ? t.finance.participantsHintBefore : t.finance.participantsHint}
            </Muted>
            {!personRows.length && !guestDebts.length ? (
              <Muted>{t.finance.noJoinersYet}</Muted>
            ) : null}

            {personRows.length >= 4 ? (
              <View style={styles.rowWrap}>
                <Chip
                  label={`${t.finance.filterAll} (${filterCounts.all})`}
                  active={personFilter === 'all'}
                  onPress={() => setPersonFilter('all')}
                />
                <Chip
                  label={`${t.finance.filterUnpaid} (${filterCounts.unpaid})`}
                  active={personFilter === 'unpaid'}
                  onPress={() => setPersonFilter('unpaid')}
                />
                <Chip
                  label={`${t.finance.filterPartial} (${filterCounts.partial})`}
                  active={personFilter === 'partial'}
                  onPress={() => setPersonFilter('partial')}
                />
                <Chip
                  label={`${t.finance.filterPaid} (${filterCounts.paid})`}
                  active={personFilter === 'paid'}
                  onPress={() => setPersonFilter('paid')}
                />
              </View>
            ) : null}

            {guestDebts.map((g) => {
              const status =
                g.status === 'paid' ? 'paid' : g.status === 'waived' ? 'none' : 'unpaid';
              return (
                <View key={`guest:${g.attendanceId}`} style={styles.personBlock}>
                  <View style={styles.personHeader}>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={styles.name}>
                        {g.name} {t.finance.guestSuffix}
                      </Text>
                      <Muted>{t.finance.guestFeeHint}</Muted>
                      <Text style={styles.amountLine}>
                        {t.finance.paidLabel}: {formatEuro(g.amountPaid)}
                      </Text>
                      <Text style={styles.amountLine}>
                        {t.finance.openBalance}: {formatEuro(g.open)}
                      </Text>
                    </View>
                    <StatusBadge status={status} t={t} />
                  </View>
                  {canManage ? (
                    <View style={[styles.actions, { paddingHorizontal: 4, paddingBottom: 8 }]}>
                      {g.status !== 'paid' ? (
                        <Pressable disabled={busy} onPress={() => void onToggleGuestPaid(g, true)}>
                          <Text style={styles.link}>{t.finance.markReceived}</Text>
                        </Pressable>
                      ) : (
                        <Pressable disabled={busy} onPress={() => void onToggleGuestPaid(g, false)}>
                          <Text style={styles.link}>{t.finance.markUnpaid}</Text>
                        </Pressable>
                      )}
                    </View>
                  ) : null}
                </View>
              );
            })}

            {personFilter !== 'all' && !visiblePersonRows.length ? (
              <Muted>{t.finance.noParticipantsYet}</Muted>
            ) : null}

            {visiblePersonRows.map((row) => {
              const open = detailUserId === row.userId;
              return (
                <View key={row.userId} style={styles.personBlock}>
                  <Pressable
                    onPress={() => {
                      setDetailUserId(open ? null : row.userId);
                      setEditing(false);
                      setPayAmount(row.open > 0 ? String(row.open) : '');
                      setEditMode(row.mode === 'annual' ? 'fixed' : row.mode);
                      setEditAmount(String(row.amount));
                    }}
                    style={styles.personHeader}>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={styles.name}>
                        {displayName(profilesById.get(row.userId) ?? null)}
                      </Text>
                      {personChargeLines(row, t).map((line) => (
                        <Muted key={line}>{line}</Muted>
                      ))}
                      <Text style={styles.amountLine}>
                        {t.finance.paidLabel}: {formatEuro(row.paid)}
                      </Text>
                      <Text style={styles.amountLine}>
                        {t.finance.openBalance}: {formatEuro(row.open)}
                      </Text>
                    </View>
                    <StatusBadge status={row.status} t={t} />
                  </Pressable>

                  {open && detailRow ? (
                    <View style={styles.detail}>
                      <Muted>
                        {t.finance.dueTogether}: {formatEuro(detailRow.due)}
                      </Muted>
                      <Muted>
                        {t.finance.paidLabel}: {formatEuro(detailRow.paid)}
                      </Muted>
                      <Muted>
                        {t.finance.openBalance}: {formatEuro(detailRow.open)}
                      </Muted>

                      {canManage ? (
                        <>
                          {!editing ? (
                            <View style={styles.actions}>
                              <Pressable
                                onPress={() => {
                                  setEditing(true);
                                  setEditMode(
                                    detailRow.mode === 'annual' || detailRow.mode === 'fixed'
                                      ? 'fixed'
                                      : 'per_event'
                                  );
                                  setEditAmount(String(detailRow.amount));
                                }}>
                                <Text style={styles.link}>{t.finance.editPerson}</Text>
                              </Pressable>
                              {detailRow.due <= 0 && detailRow.visits > 0 ? (
                                <Pressable disabled={busy} onPress={() => void onChargeIfNeeded()}>
                                  <Text style={styles.link}>{t.finance.chargeManually}</Text>
                                </Pressable>
                              ) : null}
                            </View>
                          ) : (
                            <View style={{ gap: 8 }}>
                              <Muted>{t.finance.paymentMethod}</Muted>
                              <View style={styles.rowWrap}>
                                <Chip
                                  label={t.form.payPerEvent}
                                  active={editMode === 'per_event'}
                                  onPress={() => setEditMode('per_event')}
                                />
                                {activity.is_recurring ? (
                                  <Chip
                                    label={t.form.payFixed}
                                    active={editMode === 'fixed'}
                                    onPress={() => setEditMode('fixed')}
                                  />
                                ) : null}
                              </View>
                              <Input
                                label={t.finance.expenseAmount}
                                value={editAmount}
                                onChangeText={setEditAmount}
                                keyboardType="decimal-pad"
                              />
                              <Muted>{t.finance.feesToBudget}</Muted>
                              <Button
                                label={t.finance.saveFee}
                                size="sm"
                                loading={busy}
                                onPress={() => void onSaveSettings()}
                              />
                              <Text style={styles.link} onPress={() => setEditing(false)}>
                                {t.common.cancel}
                              </Text>
                            </View>
                          )}

                          {detailRow.open > 0 ? (
                            <View style={{ gap: 8, marginTop: 8 }}>
                              <Subtitle>{t.finance.addPayment}</Subtitle>
                              <Input
                                label={t.finance.paymentAmount}
                                value={payAmount}
                                onChangeText={setPayAmount}
                                keyboardType="decimal-pad"
                              />
                              <Input
                                label={t.finance.paymentNote}
                                value={payNote}
                                onChangeText={setPayNote}
                              />
                              <Button
                                label={t.finance.addPayment}
                                loading={busy}
                                onPress={() => void onRecordPayment()}
                              />
                            </View>
                          ) : null}
                        </>
                      ) : null}

                      <Subtitle>{t.finance.attendances}</Subtitle>
                      {!detailJoins.length ? <Muted>—</Muted> : null}
                      {detailJoins.map((j, idx) => {
                        const obl = j.fee_obligation_id
                          ? oblById.get(j.fee_obligation_id)
                          : null;
                        const price =
                          j.fee_amount != null
                            ? Number(j.fee_amount)
                            : detailRow.mode === 'per_event'
                              ? detailRow.amount
                              : null;
                        const paidSession =
                          obl != null
                            ? Number(obl.amount_paid) + 0.001 >= Number(obl.amount_due)
                            : detailRow.mode !== 'per_event'
                              ? detailRow.status === 'paid'
                              : false;
                        return (
                          <View key={`${j.activity_id}-${j.user_id}`} style={styles.sessionRow}>
                            <Text style={styles.sessionTitle}>
                              {formatDate(j.starts_at)} · #{idx + 1} · {t.finance.sessionPresent}
                            </Text>
                            {price != null ? (
                              <Muted>
                                {t.finance.sessionPrice}: {price.toFixed(2)} € ·{' '}
                                {paidSession ? t.finance.sessionPaidYes : t.finance.sessionPaidNo}
                              </Muted>
                            ) : (
                              <Muted>
                                {modeLabel(detailRow.mode, t)} · {detailRow.amount.toFixed(2)} €
                              </Muted>
                            )}
                          </View>
                        );
                      })}

                      <Subtitle>{t.finance.personTransactions}</Subtitle>
                      {!detailLedger.length ? <Muted>{t.finance.noTransactions}</Muted> : null}
                      {detailLedger.map((l) => (
                        <LedgerLine
                          key={l.id}
                          entry={l}
                          profilesById={profilesById}
                          t={t}
                        />
                      ))}
                    </View>
                  ) : null}
                </View>
              );
            })}
          </View>
        </View>
      ) : null}

      {tab === 'transactions' ? (
        <View style={styles.card}>
          <Subtitle>{t.finance.allTransactions}</Subtitle>
          {!ledger.length ? <Muted>{t.finance.noTransactions}</Muted> : null}
          {ledger.map((l) => (
            <LedgerLine key={l.id} entry={l} profilesById={profilesById} t={t} />
          ))}
          {expenses.filter(isActualExpense).length ? (
            <>
              <Subtitle>{t.finance.expenses}</Subtitle>
              {expenses.filter(isActualExpense).map((e) => (
                <View key={e.id} style={styles.txRow}>
                  <Text style={styles.txExpense}>-{Number(e.amount).toFixed(2)} €</Text>
                  <Text style={styles.name}>{e.title}</Text>
                  <Muted>
                    {categoryLabel(e.category, t)} · {formatDate(e.created_at)}
                    {e.paid_from_budget ? ` · ${t.finance.paidFromBudget}` : ''}
                    {e.created_by
                      ? ` · ${t.finance.addedBy(displayName(profilesById.get(e.created_by) ?? null))}`
                      : ''}
                  </Muted>
                </View>
              ))}
            </>
          ) : null}
        </View>
      ) : null}

      {tab === 'expense' && canManage ? (
        <View style={styles.card}>
          <Subtitle>{t.finance.addExpenseAction}</Subtitle>
          <Muted>{t.finance.fromBudgetHint}</Muted>
          <Input
            label={t.finance.expenseTitle}
            value={expTitle}
            onChangeText={setExpTitle}
            placeholder={t.finance.expenseTitleHint}
          />
          <Input
            label={t.finance.expenseAmount}
            value={expAmount}
            onChangeText={setExpAmount}
            keyboardType="decimal-pad"
          />
          <Muted>{t.finance.expenseCategory}</Muted>
          <View style={styles.rowWrap}>
            {EXPENSE_CATEGORIES.map((c) => (
              <Chip
                key={c}
                label={categoryLabel(c, t)}
                active={expCategory === c}
                onPress={() => setExpCategory(c)}
              />
            ))}
          </View>
          <Button label={t.finance.createExpense} loading={busy} onPress={() => void onAddExpense()} />
        </View>
      ) : null}
    </View>
  );
}

function StatusBadge({
  status,
  t,
}: {
  status: PersonRow['status'];
  t: ReturnType<typeof useT>;
}) {
  const label =
    status === 'paid'
      ? t.finance.statusPaidFull
      : status === 'partial'
        ? t.finance.statusPartial
        : status === 'unpaid'
          ? t.finance.statusUnpaidFull
          : status === 'waiting'
            ? t.finance.statusWaiting
            : '—';
  const color =
    status === 'paid'
      ? theme.colors.success
      : status === 'partial'
        ? theme.colors.warning
        : status === 'unpaid'
          ? theme.colors.danger
          : theme.colors.textMuted;
  return (
    <View style={[styles.badge, { borderColor: color }]}>
      <Text style={[styles.badgeText, { color }]}>{label}</Text>
    </View>
  );
}

function LedgerLine({
  entry,
  profilesById,
  t,
}: {
  entry: SeriesFinanceLedgerEntry;
  profilesById: Map<string, Profile>;
  t: ReturnType<typeof useT>;
}) {
  const income = entry.entry_type === 'INCOME';
  const who = entry.user_id ? displayName(profilesById.get(entry.user_id) ?? null) : null;
  const by = displayName(profilesById.get(entry.created_by) ?? null);
  return (
    <View style={styles.txRow}>
      <Text style={income ? styles.txIncome : styles.txExpense}>
        {income ? '+' : '-'}
        {Number(entry.amount).toFixed(2)} €
      </Text>
      <Text style={styles.name}>
        {entry.description || (income ? t.finance.incomeLabel : t.finance.expenseLabel)}
      </Text>
      <Muted>
        {formatDate(entry.occurred_at)}
        {who ? ` · ${who}` : ''}
        {entry.category ? ` · ${categoryLabel(entry.category, t)}` : ''}
        {` · ${t.finance.receivedBy(by)}`}
      </Muted>
    </View>
  );
}

function SummaryCard({
  label,
  value,
  emphasize,
}: {
  label: string;
  value: string;
  emphasize?: boolean;
}) {
  return (
    <View style={[styles.summaryCard, emphasize && styles.summaryEmphasize]}>
      <Muted>{label}</Muted>
      <Text style={[styles.summaryValue, emphasize && styles.summaryValueBig]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  summaryRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  summaryCard: {
    flex: 1,
    minWidth: 90,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: 10,
  },
  summaryEmphasize: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.primarySoft,
  },
  summaryValue: { fontWeight: '800', fontSize: 16, color: theme.colors.text, marginTop: 4 },
  summaryValueBig: { fontSize: 22, color: theme.colors.primaryDark },
  tabRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.space.md,
    gap: 6,
  },
  infoCard: {
    backgroundColor: theme.colors.primarySoft,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.space.md,
    gap: 4,
  },
  infoTitle: { fontWeight: '800', fontSize: 14, color: theme.colors.primaryDark },
  rowWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  name: { fontWeight: '700', fontSize: 15, color: theme.colors.text },
  amountLine: { fontWeight: '600', fontSize: 13, color: theme.colors.text },
  link: { color: theme.colors.primary, fontWeight: '700' },
  personBlock: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
    paddingTop: 10,
    marginTop: 8,
  },
  personHeader: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  detail: { marginTop: 10, gap: 6, paddingLeft: 4 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 16, marginTop: 4 },
  sessionRow: { marginTop: 4, gap: 2 },
  sessionTitle: { fontWeight: '600', color: theme.colors.text, fontSize: 13 },
  txRow: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
    gap: 2,
  },
  txIncome: { fontWeight: '800', fontSize: 16, color: theme.colors.success },
  txExpense: { fontWeight: '800', fontSize: 16, color: theme.colors.danger },
  badge: {
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  badgeText: { fontSize: 10, fontWeight: '800' },
  error: { color: theme.colors.danger, fontWeight: '600' },
});
