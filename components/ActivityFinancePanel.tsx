import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { Button, Chip, Input, Muted, Subtitle } from '@/components/ui';
import {
  computeBudget,
  createExpense,
  createExtraFundingCharges,
  createManualFundingFee,
  deleteExpense,
  fetchSeriesMemberFinanceSettings,
  fetchSeriesObligations,
  fundingFeeUserId,
  parseMonthlyFeeKey,
  removeMonthlyFundingFee,
  resolveEligiblePayerIds,
  resolveMemberFinance,
  syncAttendeeFundingFees,
  fetchActivityAttendeeIds,
  fetchSeriesExpenses,
  fetchSeriesFinanceSettings,
  fetchSeriesInviteeIds,
  fetchSeriesMemberProfiles,
  isActualExpense,
  seriesKey,
  setObligationPaid,
  upsertMemberFinanceSettings,
  type ExpenseWithMeta,
} from '@/lib/finance';
import { fetchSeriesAttendanceStats } from '@/lib/guests';
import type {
  ActivityObligation,
  ActivityWithRelations,
  FundingMode,
  Profile,
  SeriesFinanceMemberSettings,
  SeriesFinanceSettings,
} from '@/lib/types';
import { displayName } from '@/lib/types';
import { useT } from '@/i18n';
import { theme } from '@/constants/theme';

type Props = {
  activity: ActivityWithRelations;
  userId: string;
  canManage: boolean;
  attendees: Profile[];
};

type Tab = 'budget' | 'expenses' | 'collect';
type SplitPreset = 'invitees' | 'attendees' | 'custom';
type PayerChoice = string | 'budget';

type ParticipantRow = {
  userId: string;
  seriesCount: number;
  here: boolean;
  mode: FundingMode;
  amount: number;
  unpaidObligations: ActivityObligation[];
  paidObligations: ActivityObligation[];
  feeExpenses: ExpenseWithMeta[];
  allPaid: boolean;
  openDue: number;
};

function isGuestFeeKey(periodKey: string | null | undefined): boolean {
  return (periodKey ?? '').startsWith('fee:guest:');
}

function modeLabel(
  mode: FundingMode,
  t: ReturnType<typeof useT>
): string {
  if (mode === 'monthly') return t.form.payMonthly;
  if (mode === 'fixed' || mode === 'annual') return t.form.payFixed;
  return t.form.payPerEvent;
}

export function ActivityFinancePanel({ activity, userId, canManage, attendees }: Props) {
  const t = useT();
  const sid = seriesKey(activity);
  const [tab, setTab] = useState<Tab>('budget');
  const [expenses, setExpenses] = useState<ExpenseWithMeta[]>([]);
  const [obligations, setObligations] = useState<ActivityObligation[]>([]);
  const [memberOverrides, setMemberOverrides] = useState<SeriesFinanceMemberSettings[]>([]);
  const [members, setMembers] = useState<Profile[]>([]);
  const [inviteeIds, setInviteeIds] = useState<string[]>([]);
  const [attendeeIds, setAttendeeIds] = useState<string[]>([]);
  const [eligibleIds, setEligibleIds] = useState<string[]>([]);
  const [splitPreset, setSplitPreset] = useState<SplitPreset>('invitees');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [financeSettings, setFinanceSettings] = useState<SeriesFinanceSettings | null>(null);
  const [attendanceStats, setAttendanceStats] = useState<Awaited<
    ReturnType<typeof fetchSeriesAttendanceStats>
  > | null>(null);

  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [editMode, setEditMode] = useState<FundingMode>('per_event');
  const [editAmount, setEditAmount] = useState('');

  const [showAdd, setShowAdd] = useState(false);
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [paidBy, setPaidBy] = useState<PayerChoice>('budget');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const [collectTitle, setCollectTitle] = useState('');
  const [collectAmount, setCollectAmount] = useState('');
  const [collectIds, setCollectIds] = useState<string[]>([]);

  const profilesById = useMemo(() => {
    const map = new Map(members.map((m) => [m.id, m]));
    for (const a of attendees) map.set(a.id, a);
    return map;
  }, [members, attendees]);

  const overrideMap = useMemo(
    () => new Map(memberOverrides.map((r) => [r.user_id, r])),
    [memberOverrides]
  );

  const budget = useMemo(() => computeBudget(expenses, obligations), [expenses, obligations]);
  const actualExpenses = useMemo(() => expenses.filter(isActualExpense), [expenses]);
  const feeExpenses = useMemo(
    () => expenses.filter((e) => (e.period_key ?? '').startsWith('fee:') && !isGuestFeeKey(e.period_key)),
    [expenses]
  );
  const guestFeeRows = useMemo(
    () => expenses.filter((e) => isGuestFeeKey(e.period_key)),
    [expenses]
  );

  const seriesCountByUser = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of attendanceStats?.memberAttendances ?? []) {
      map.set(m.userId, m.count);
    }
    return map;
  }, [attendanceStats]);

  const participantRows = useMemo((): ParticipantRow[] => {
    if (!financeSettings) return [];
    const hereSet = new Set(attendeeIds);
    const ids = new Set<string>();
    for (const id of eligibleIds) {
      if (id !== activity.created_by) ids.add(id);
    }
    for (const id of seriesCountByUser.keys()) {
      if (id !== activity.created_by) ids.add(id);
    }
    for (const e of feeExpenses) {
      const uid = fundingFeeUserId(e.period_key);
      if (uid) ids.add(uid);
    }

    const rows: ParticipantRow[] = [];
    for (const uid of ids) {
      const { mode, amount: amt } = resolveMemberFinance(financeSettings, overrideMap, uid);
      const personFees = feeExpenses.filter((e) => fundingFeeUserId(e.period_key) === uid);
      const personObls = obligations.filter(
        (o) => o.user_id === uid && personFees.some((e) => e.id === o.expense_id)
      );
      const unpaid = personObls.filter(
        (o) => o.status !== 'paid' && o.status !== 'waived' && (Number(o.amount_paid) || 0) < Number(o.amount_due) - 0.001
      );
      const paid = personObls.filter((o) => o.status === 'paid' || (Number(o.amount_paid) || 0) > 0);
      const openDue = unpaid.reduce((s, o) => s + Math.max(0, Number(o.amount_due) - Number(o.amount_paid)), 0);
      rows.push({
        userId: uid,
        seriesCount: seriesCountByUser.get(uid) ?? 0,
        here: hereSet.has(uid),
        mode,
        amount: amt,
        unpaidObligations: unpaid,
        paidObligations: paid,
        feeExpenses: personFees,
        allPaid: personFees.length > 0 && unpaid.length === 0,
        openDue: Math.round(openDue * 100) / 100,
      });
    }

    rows.sort((a, b) => {
      if (a.allPaid !== b.allPaid) return a.allPaid ? 1 : -1;
      return displayName(profilesById.get(a.userId) ?? null).localeCompare(
        displayName(profilesById.get(b.userId) ?? null)
      );
    });
    return rows;
  }, [
    financeSettings,
    eligibleIds,
    activity.created_by,
    seriesCountByUser,
    feeExpenses,
    obligations,
    overrideMap,
    attendeeIds,
    profilesById,
  ]);

  const totalSpent = useMemo(
    () => actualExpenses.reduce((s, e) => s + (Number(e.amount) || 0), 0),
    [actualExpenses]
  );

  const applyPreset = useCallback(
    (preset: SplitPreset, invitees: string[], attendeesList: string[], people: Profile[]) => {
      setSplitPreset(preset);
      if (preset === 'invitees') {
        const ids = invitees.length ? invitees : people.map((p) => p.id);
        setSelectedIds(ids);
      } else if (preset === 'attendees') {
        const ids = attendeesList.length ? attendeesList : people.map((p) => p.id);
        setSelectedIds(ids);
      }
    },
    []
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let settings: SeriesFinanceSettings | null = null;
      try {
        settings = await fetchSeriesFinanceSettings(sid);
        setFinanceSettings(settings);
        if (settings && activity.finance_enabled) {
          await syncAttendeeFundingFees({ activity, settings });
          setEligibleIds(await resolveEligiblePayerIds(settings));
          setMemberOverrides(await fetchSeriesMemberFinanceSettings(sid));
        } else {
          setEligibleIds([]);
          setMemberOverrides([]);
        }
      } catch {
        setFinanceSettings(null);
        setEligibleIds([]);
        setMemberOverrides([]);
      }

      const [exps, mems, obls, invites, attendeesForEvent, stats] = await Promise.all([
        fetchSeriesExpenses(sid),
        fetchSeriesMemberProfiles(sid),
        fetchSeriesObligations(sid),
        fetchSeriesInviteeIds(sid),
        fetchActivityAttendeeIds(activity.id),
        fetchSeriesAttendanceStats(sid).catch(() => null),
      ]);
      const people = mems.length ? mems : attendees;
      const inviteSet = invites.length
        ? invites
        : [
            activity.created_by,
            ...(activity.series_invite_user_ids ?? []),
            ...people.map((p) => p.id),
          ];
      const uniqueInvites = Array.from(new Set(inviteSet));
      setExpenses(exps);
      setObligations(obls);
      setMembers(people);
      setInviteeIds(uniqueInvites);
      setAttendeeIds(attendeesForEvent);
      setAttendanceStats(stats);

      setSelectedIds((prev) => {
        if (prev.length) return prev.filter((id) => people.some((p) => p.id === id));
        return uniqueInvites.filter((id) => people.some((p) => p.id === id)).length
          ? uniqueInvites.filter((id) => people.some((p) => p.id === id))
          : people.map((p) => p.id);
      });
      setCollectIds((prev) =>
        prev.length
          ? prev.filter((id) => people.some((p) => p.id === id))
          : uniqueInvites.filter((id) => people.some((p) => p.id === id))
      );
      applyPreset('invitees', uniqueInvites, attendeesForEvent, people);
      setPaidBy('budget');
      setEditingUserId(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : t.common.error;
      setError(/relation|does not exist|function|column/i.test(msg) ? t.finance.runSql : msg);
    } finally {
      setLoading(false);
    }
  }, [activity, attendees, applyPreset, sid, t.common.error, t.finance.runSql]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onAddExpense() {
    if (!canManage) return;
    const n = Number(amount.replace(',', '.'));
    const fromBudget = paidBy === 'budget';
    if (!title.trim()) {
      Alert.alert(t.common.error, t.finance.needTitle);
      return;
    }
    if (!Number.isFinite(n) || n <= 0) {
      Alert.alert(t.common.error, t.finance.needAmount);
      return;
    }
    if (!fromBudget && !selectedIds.length) {
      Alert.alert(t.common.error, t.finance.needMembers);
      return;
    }
    setBusy(true);
    try {
      await createExpense({
        seriesId: sid,
        title: title.trim(),
        amount: n,
        splitMode:
          splitPreset === 'attendees'
            ? 'equal_attendees'
            : splitPreset === 'invitees'
              ? 'equal_all'
              : 'selected',
        memberIds: fromBudget
          ? selectedIds.length
            ? selectedIds
            : [activity.created_by]
          : selectedIds,
        paidBy: fromBudget ? null : paidBy,
        paidFromBudget: fromBudget,
        activityId: activity.id,
      });
      setTitle('');
      setAmount('');
      setShowAdd(false);
      await load();
    } catch (e) {
      Alert.alert(t.common.error, e instanceof Error ? e.message : t.common.error);
    } finally {
      setBusy(false);
    }
  }

  async function onCollect() {
    if (!canManage) return;
    const n = Number(collectAmount.replace(',', '.'));
    if (!collectTitle.trim()) {
      Alert.alert(t.common.error, t.finance.needTitle);
      return;
    }
    if (!Number.isFinite(n) || n <= 0) {
      Alert.alert(t.common.error, t.finance.needAmount);
      return;
    }
    if (!collectIds.length) {
      Alert.alert(t.common.error, t.finance.needMembers);
      return;
    }
    setBusy(true);
    try {
      await createExtraFundingCharges({
        seriesId: sid,
        activityId: activity.id,
        title: collectTitle.trim(),
        amount: n,
        userIds: collectIds,
        organizerId: activity.created_by,
      });
      setCollectTitle('');
      setCollectAmount('');
      setTab('budget');
      await load();
    } catch (e) {
      Alert.alert(t.common.error, e instanceof Error ? e.message : t.common.error);
    } finally {
      setBusy(false);
    }
  }

  async function onTogglePersonPaid(row: ParticipantRow, paid: boolean) {
    if (!canManage) return;
    const targets = paid
      ? row.unpaidObligations
      : row.paidObligations.length
        ? row.paidObligations
        : row.feeExpenses
            .map((e) =>
              obligations.find((o) => o.expense_id === e.id && o.user_id === row.userId)
            )
            .filter(Boolean);
    if (!targets.length) return;
    setBusy(true);
    try {
      for (const obl of targets as ActivityObligation[]) {
        await setObligationPaid(obl.id, paid);
      }
      await load();
    } catch (e) {
      Alert.alert(t.common.error, e instanceof Error ? e.message : t.common.error);
    } finally {
      setBusy(false);
    }
  }

  async function onSaveMemberSettings(row: ParticipantRow) {
    if (!canManage || !financeSettings) return;
    const n = Number(editAmount.replace(',', '.'));
    if (!Number.isFinite(n) || n < 0) {
      Alert.alert(t.common.error, t.finance.needAmount);
      return;
    }
    setBusy(true);
    try {
      await upsertMemberFinanceSettings({
        seriesId: sid,
        userId: row.userId,
        fundingMode: editMode,
        amount: n,
        updatedBy: userId,
        activity,
        settings: financeSettings,
      });
      setEditingUserId(null);
      await load();
    } catch (e) {
      Alert.alert(t.common.error, e instanceof Error ? e.message : t.common.error);
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteExpense(id: string) {
    if (!canManage) return;
    setBusy(true);
    try {
      await deleteExpense(id);
      await load();
    } catch (e) {
      Alert.alert(t.common.error, e instanceof Error ? e.message : t.common.error);
    } finally {
      setBusy(false);
    }
  }

  async function onDeletePersonFees(row: ParticipantRow) {
    if (!canManage || !row.feeExpenses.length) return;
    const first = row.feeExpenses[0];
    const monthly = parseMonthlyFeeKey(first.period_key);
    if (!monthly) {
      for (const e of row.feeExpenses) {
        await onDeleteExpense(e.id);
      }
      return;
    }
    Alert.alert(t.finance.removeMonthlyTitle, t.finance.removeMonthlyBody, [
      { text: t.common.cancel, style: 'cancel' },
      {
        text: t.finance.removeThisMonthOnly,
        onPress: () => {
          void (async () => {
            setBusy(true);
            try {
              for (const e of row.feeExpenses) {
                if (!parseMonthlyFeeKey(e.period_key)) continue;
                await removeMonthlyFundingFee({
                  seriesId: sid,
                  expenseId: e.id,
                  periodKey: e.period_key!,
                  mode: 'this_month',
                });
              }
              await load();
            } catch (err) {
              Alert.alert(t.common.error, err instanceof Error ? err.message : t.common.error);
            } finally {
              setBusy(false);
            }
          })();
        },
      },
      {
        text: t.finance.stopFutureMonths,
        style: 'destructive',
        onPress: () => {
          void (async () => {
            setBusy(true);
            try {
              const e = row.feeExpenses[0];
              await removeMonthlyFundingFee({
                seriesId: sid,
                expenseId: e.id,
                periodKey: e.period_key!,
                mode: 'stop_future',
              });
              await load();
            } catch (err) {
              Alert.alert(t.common.error, err instanceof Error ? err.message : t.common.error);
            } finally {
              setBusy(false);
            }
          })();
        },
      },
    ]);
  }

  async function onChargeManually(personId: string) {
    if (!canManage || !financeSettings) return;
    setBusy(true);
    try {
      const { amount: amt } = resolveMemberFinance(financeSettings, overrideMap, personId);
      await createManualFundingFee({
        activity,
        settings: financeSettings,
        userId: personId,
        amount: amt,
      });
      await load();
    } catch (e) {
      Alert.alert(t.common.error, e instanceof Error ? e.message : t.common.error);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Muted>{t.common.loading}</Muted>;
  if (error) return <Text style={styles.error}>{error}</Text>;

  const hereCount = attendeeIds.length;

  return (
    <View style={{ gap: 12 }}>
      <View style={styles.tabRow}>
        <Chip label={t.finance.budgetTab} active={tab === 'budget'} onPress={() => setTab('budget')} />
        <Chip
          label={t.finance.expenses}
          active={tab === 'expenses'}
          onPress={() => setTab('expenses')}
        />
        <Chip
          label={t.finance.collectTab}
          active={tab === 'collect'}
          onPress={() => setTab('collect')}
        />
      </View>

      {!canManage ? <Muted>{t.finance.viewOnly}</Muted> : null}

      {tab === 'budget' ? (
        <View style={{ gap: 12 }}>
          <View style={styles.summaryRow}>
            <SummaryCard label={t.finance.budget} value={`${budget.remaining.toFixed(2)} €`} />
            <SummaryCard label={t.finance.totalSpent} value={`${totalSpent.toFixed(2)} €`} />
          </View>
          <View style={styles.summaryRow}>
            <SummaryCard label={t.finance.budgetIn} value={`${budget.funded.toFixed(2)} €`} />
            <SummaryCard label={t.finance.budgetOut} value={`${budget.spent.toFixed(2)} €`} />
          </View>

          {financeSettings ? (
            <Muted>
              {t.finance.seriesDefault(
                modeLabel(
                  financeSettings.funding_mode === 'annual' ? 'fixed' : financeSettings.funding_mode,
                  t
                ),
                Number(financeSettings.amount)
              )}
            </Muted>
          ) : null}

          <Muted>{t.finance.occurrenceHeadcount(hereCount)}</Muted>

          <View style={styles.card}>
            <Subtitle>{t.finance.participants}</Subtitle>
            <Muted>{t.finance.participantsHint}</Muted>

            {!participantRows.length ? <Muted>{t.finance.noParticipantsYet}</Muted> : null}

            {participantRows.map((row) => {
              const editing = editingUserId === row.userId;
              const paid = row.allPaid && row.feeExpenses.length > 0;
              const displayAmount = paid
                ? row.paidObligations.reduce((s, o) => s + (Number(o.amount_paid) || 0), 0) ||
                  row.amount
                : row.openDue > 0
                  ? row.openDue
                  : row.amount;
              return (
                <View key={row.userId} style={styles.feeRow}>
                  <View style={styles.feeTop}>
                    {row.feeExpenses.length || row.openDue > 0 ? (
                      canManage ? (
                        <Pressable
                          disabled={busy || (!paid && !row.unpaidObligations.length)}
                          onPress={() => void onTogglePersonPaid(row, !paid)}
                          hitSlop={8}
                          accessibilityRole="checkbox"
                          accessibilityState={{ checked: paid }}
                          style={[styles.check, paid && styles.checkOn]}>
                          <Text style={styles.checkMark}>{paid ? '✓' : ''}</Text>
                        </Pressable>
                      ) : (
                        <View style={[styles.check, paid && styles.checkOn, styles.checkReadonly]}>
                          <Text style={styles.checkMark}>{paid ? '✓' : ''}</Text>
                        </View>
                      )
                    ) : (
                      <View style={[styles.check, styles.checkEmpty]} />
                    )}
                    <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                      <Text style={styles.name}>
                        {displayName(profilesById.get(row.userId) ?? null)}
                      </Text>
                      <Muted>
                        {t.finance.participantMeta(
                          row.seriesCount,
                          row.here,
                          modeLabel(row.mode, t)
                        )}
                      </Muted>
                      <Text style={styles.amount}>{displayAmount.toFixed(2)} €</Text>
                      <Muted>
                        {paid
                          ? t.finance.statusPaid
                          : row.feeExpenses.length
                            ? t.finance.statusUnpaid
                            : row.seriesCount > 0 || row.here
                              ? t.finance.statusNotCharged
                              : t.finance.statusNoAttendance}
                      </Muted>
                    </View>
                  </View>

                  {editing ? (
                    <View style={{ gap: 8, marginTop: 6 }}>
                      <Muted>{t.finance.paymentMethod}</Muted>
                      <View style={styles.rowWrap}>
                        <Chip
                          label={t.form.payPerEvent}
                          active={editMode === 'per_event'}
                          onPress={() => setEditMode('per_event')}
                        />
                        {activity.is_recurring ? (
                          <>
                            <Chip
                              label={t.form.payMonthly}
                              active={editMode === 'monthly'}
                              onPress={() => setEditMode('monthly')}
                            />
                            <Chip
                              label={t.form.payFixed}
                              active={editMode === 'fixed'}
                              onPress={() => setEditMode('fixed')}
                            />
                          </>
                        ) : null}
                      </View>
                      <Input
                        label={t.finance.expenseAmount}
                        value={editAmount}
                        onChangeText={setEditAmount}
                        keyboardType="decimal-pad"
                      />
                      <Button
                        label={t.finance.saveFee}
                        size="sm"
                        loading={busy}
                        onPress={() => void onSaveMemberSettings(row)}
                      />
                      <Text style={styles.link} onPress={() => setEditingUserId(null)}>
                        {t.common.cancel}
                      </Text>
                    </View>
                  ) : canManage ? (
                    <View style={styles.feeActions}>
                      <Pressable
                        disabled={busy}
                        onPress={() => {
                          setEditingUserId(row.userId);
                          setEditMode(row.mode === 'annual' ? 'fixed' : row.mode);
                          setEditAmount(String(row.amount));
                        }}>
                        <Text style={styles.link}>{t.finance.editPerson}</Text>
                      </Pressable>
                      {!row.feeExpenses.length && (row.here || row.seriesCount > 0) ? (
                        <Pressable disabled={busy} onPress={() => void onChargeManually(row.userId)}>
                          <Text style={styles.link}>{t.finance.chargeManually}</Text>
                        </Pressable>
                      ) : null}
                      {row.feeExpenses.length ? (
                        <Pressable disabled={busy} onPress={() => void onDeletePersonFees(row)}>
                          <Text style={styles.linkMuted}>{t.finance.deleteExpense}</Text>
                        </Pressable>
                      ) : null}
                    </View>
                  ) : null}
                </View>
              );
            })}

            {guestFeeRows.map((e) => (
              <View key={e.id} style={styles.feeRow}>
                <Text style={styles.name}>{e.title}</Text>
                <Text style={styles.amount}>{Number(e.amount).toFixed(2)} €</Text>
                <Muted>{t.finance.guestIntoBudget}</Muted>
              </View>
            ))}
          </View>

          {attendanceStats?.guestAttendances.length ? (
            <View style={styles.card}>
              <Subtitle>{t.finance.attendanceStats}</Subtitle>
              {attendanceStats.guestAttendances.map((g) => (
                <Text key={g.guestId} style={styles.statLine}>
                  {t.finance.guestStat(g.name, g.count, g.totalPaid)}
                </Text>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}

      {tab === 'expenses' ? (
        <View style={{ gap: 12 }}>
          {canManage ? (
            !showAdd ? (
              <Button label={t.finance.addExpense} onPress={() => setShowAdd(true)} />
            ) : (
              <View style={styles.card}>
                <Subtitle>{t.finance.addExpense}</Subtitle>
                <Muted>{t.finance.expenseHint}</Muted>
                <Input
                  label={t.finance.expenseTitle}
                  value={title}
                  onChangeText={setTitle}
                  placeholder={t.finance.expenseTitleHint}
                />
                <Input
                  label={t.finance.expenseAmount}
                  value={amount}
                  onChangeText={setAmount}
                  keyboardType="decimal-pad"
                />
                <Muted>{t.finance.paidBy}</Muted>
                <View style={styles.rowWrap}>
                  <Chip
                    label={t.finance.fromBudget}
                    active={paidBy === 'budget'}
                    onPress={() => setPaidBy('budget')}
                  />
                  {members.map((m) => (
                    <Chip
                      key={m.id}
                      label={displayName(m)}
                      active={paidBy === m.id}
                      onPress={() => setPaidBy(m.id)}
                    />
                  ))}
                </View>
                {paidBy !== 'budget' ? (
                  <>
                    <Muted>{t.finance.splitAmong}</Muted>
                    <View style={styles.rowWrap}>
                      <Chip
                        label={t.finance.splitAllInvitees}
                        active={splitPreset === 'invitees'}
                        onPress={() => applyPreset('invitees', inviteeIds, attendeeIds, members)}
                      />
                      <Chip
                        label={t.finance.splitAttendees}
                        active={splitPreset === 'attendees'}
                        onPress={() => applyPreset('attendees', inviteeIds, attendeeIds, members)}
                      />
                      <Chip
                        label={t.finance.splitCustom}
                        active={splitPreset === 'custom'}
                        onPress={() => setSplitPreset('custom')}
                      />
                    </View>
                    <View style={styles.rowWrap}>
                      {members.map((m) => {
                        const on = selectedIds.includes(m.id);
                        return (
                          <Chip
                            key={m.id}
                            label={displayName(m)}
                            active={on}
                            onPress={() => {
                              setSplitPreset('custom');
                              setSelectedIds((prev) =>
                                on ? prev.filter((id) => id !== m.id) : [...prev, m.id]
                              );
                            }}
                          />
                        );
                      })}
                    </View>
                  </>
                ) : (
                  <Muted>{t.finance.fromBudgetHint}</Muted>
                )}
                <Button label={t.finance.createExpense} onPress={onAddExpense} loading={busy} />
                <Text style={[styles.link, { marginTop: 4 }]} onPress={() => setShowAdd(false)}>
                  {t.common.cancel}
                </Text>
              </View>
            )
          ) : null}

          <ExpensesView
            expenses={actualExpenses}
            canManage={canManage}
            busy={busy}
            onDelete={onDeleteExpense}
            t={t}
          />
        </View>
      ) : null}

      {tab === 'collect' ? (
        <View style={{ gap: 12 }}>
          {!canManage ? (
            <Muted>{t.finance.collectViewOnly}</Muted>
          ) : (
            <View style={styles.card}>
              <Subtitle>{t.finance.collectTitle}</Subtitle>
              <Muted>{t.finance.collectHint}</Muted>
              <Input
                label={t.finance.expenseTitle}
                value={collectTitle}
                onChangeText={setCollectTitle}
                placeholder={t.finance.collectTitleHint}
              />
              <Input
                label={t.finance.expenseAmount}
                value={collectAmount}
                onChangeText={setCollectAmount}
                keyboardType="decimal-pad"
              />
              <Muted>{t.finance.collectFrom}</Muted>
              <View style={styles.rowWrap}>
                {members.map((m) => {
                  const on = collectIds.includes(m.id);
                  return (
                    <Chip
                      key={m.id}
                      label={displayName(m)}
                      active={on}
                      onPress={() =>
                        setCollectIds((prev) =>
                          on ? prev.filter((id) => id !== m.id) : [...prev, m.id]
                        )
                      }
                    />
                  );
                })}
              </View>
              <Button label={t.finance.collectCreate} onPress={onCollect} loading={busy} />
            </View>
          )}
        </View>
      ) : null}
    </View>
  );
}

function ExpensesView({
  expenses,
  canManage,
  busy,
  onDelete,
  t,
}: {
  expenses: ExpenseWithMeta[];
  canManage: boolean;
  busy: boolean;
  onDelete: (id: string) => void;
  t: ReturnType<typeof useT>;
}) {
  if (!expenses.length) return <Muted>{t.finance.noExpenses}</Muted>;

  return (
    <View style={{ gap: 8 }}>
      <Subtitle>{t.finance.expenses}</Subtitle>
      {expenses.map((e) => {
        const fromBudget = Boolean(e.paid_from_budget);
        const payerName = fromBudget ? t.finance.fromBudget : displayName(e.payer ?? null);
        const n = (e.members ?? []).length || 1;
        const share = (Number(e.amount) || 0) / n;
        return (
          <View key={e.id} style={styles.card}>
            <Text style={styles.name}>{e.title}</Text>
            <Text style={styles.amount}>{Number(e.amount).toFixed(2)} €</Text>
            <Muted>
              {fromBudget
                ? t.finance.paidFromBudget
                : `${t.finance.paidByName(payerName)} · ${t.finance.splitN(n, share)}`}
            </Muted>
            {canManage ? (
              <Pressable disabled={busy} onPress={() => onDelete(e.id)}>
                <Text style={[styles.linkMuted, { marginTop: 6 }]}>{t.finance.deleteExpense}</Text>
              </Pressable>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.summaryCard}>
      <Muted>{label}</Muted>
      <Text style={styles.summaryValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  summaryRow: { flexDirection: 'row', gap: 8 },
  summaryCard: {
    flex: 1,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: 10,
  },
  summaryValue: { fontWeight: '800', fontSize: 16, color: theme.colors.text, marginTop: 4 },
  tabRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.space.md,
    gap: 6,
  },
  rowWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  name: { fontWeight: '700', fontSize: 15, color: theme.colors.text },
  amount: { fontWeight: '800', fontSize: 18, color: theme.colors.primary },
  link: { color: theme.colors.primary, fontWeight: '700' },
  linkMuted: { color: theme.colors.textMuted, fontWeight: '600', fontSize: 13 },
  feeRow: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
    gap: 4,
  },
  feeTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  feeActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 16, marginTop: 4 },
  check: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: theme.colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 2,
  },
  checkOn: {
    backgroundColor: theme.colors.primary,
    borderColor: theme.colors.primary,
  },
  checkEmpty: { opacity: 0.35 },
  checkReadonly: { opacity: 0.85 },
  checkMark: { color: '#fff', fontWeight: '800', fontSize: 14, lineHeight: 16 },
  error: { color: theme.colors.danger, fontWeight: '600' },
  statLine: { color: theme.colors.text, fontSize: 13, marginTop: 4 },
});
