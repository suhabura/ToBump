import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { Button, Chip, Input, Muted, Subtitle } from '@/components/ui';
import {
  computeBudget,
  createExpense,
  createExtraFundingCharges,
  createManualFundingFee,
  deleteExpense,
  fetchSeriesObligations,
  fundingFeeUserId,
  isFundingExpense,
  parseMonthlyFeeKey,
  removeMonthlyFundingFee,
  resolveEligiblePayerIds,
  syncAttendeeFundingFees,
  fetchActivityAttendeeIds,
  fetchSeriesExpenses,
  fetchSeriesFinanceSettings,
  fetchSeriesInviteeIds,
  fetchSeriesMemberProfiles,
  isActualExpense,
  seriesKey,
  setObligationPaid,
  updateExpenseAmount,
  type ExpenseWithMeta,
} from '@/lib/finance';
import { fetchSeriesAttendanceStats } from '@/lib/guests';
import type { ActivityObligation, ActivityWithRelations, Profile, SeriesFinanceSettings } from '@/lib/types';
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

function isGuestFeeKey(periodKey: string | null | undefined): boolean {
  return (periodKey ?? '').startsWith('fee:guest:');
}

export function ActivityFinancePanel({ activity, userId, canManage, attendees }: Props) {
  const t = useT();
  const sid = seriesKey(activity);
  const [tab, setTab] = useState<Tab>('budget');
  const [expenses, setExpenses] = useState<ExpenseWithMeta[]>([]);
  const [obligations, setObligations] = useState<ActivityObligation[]>([]);
  const [members, setMembers] = useState<Profile[]>([]);
  const [inviteeIds, setInviteeIds] = useState<string[]>([]);
  const [attendeeIds, setAttendeeIds] = useState<string[]>([]);
  const [eligibleIds, setEligibleIds] = useState<string[]>([]);
  const [splitPreset, setSplitPreset] = useState<SplitPreset>('invitees');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [financeSettings, setFinanceSettings] = useState<SeriesFinanceSettings | null>(null);
  const [fundingMeta, setFundingMeta] = useState<{
    total: number;
    perPerson: number;
    payerCount: number;
  } | null>(null);
  const [attendanceStats, setAttendanceStats] = useState<Awaited<
    ReturnType<typeof fetchSeriesAttendanceStats>
  > | null>(null);
  const [editingFeeId, setEditingFeeId] = useState<string | null>(null);
  const [editFeeAmount, setEditFeeAmount] = useState('');

  const [showAdd, setShowAdd] = useState(false);
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [paidBy, setPaidBy] = useState<PayerChoice>(userId);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const [collectTitle, setCollectTitle] = useState('');
  const [collectAmount, setCollectAmount] = useState('');
  const [collectIds, setCollectIds] = useState<string[]>([]);

  const profilesById = useMemo(() => {
    const map = new Map(members.map((m) => [m.id, m]));
    for (const a of attendees) map.set(a.id, a);
    return map;
  }, [members, attendees]);

  const obligationByExpenseUser = useMemo(() => {
    const map = new Map<string, ActivityObligation>();
    for (const o of obligations) {
      map.set(`${o.expense_id}:${o.user_id}`, o);
    }
    return map;
  }, [obligations]);

  const budget = useMemo(() => computeBudget(expenses, obligations), [expenses, obligations]);
  const actualExpenses = useMemo(() => expenses.filter(isActualExpense), [expenses]);
  const feeExpenses = useMemo(
    () => expenses.filter((e) => (e.period_key ?? '').startsWith('fee:')),
    [expenses]
  );
  const memberFeeRows = useMemo(() => {
    return feeExpenses
      .map((e) => {
        const uid = fundingFeeUserId(e.period_key);
        if (!uid) return null;
        const obl =
          obligationByExpenseUser.get(`${e.id}:${uid}`) ??
          obligations.find((o) => o.expense_id === e.id && o.user_id === uid) ??
          null;
        return { expense: e, userId: uid, obligation: obl };
      })
      .filter(Boolean) as {
      expense: ExpenseWithMeta;
      userId: string;
      obligation: ActivityObligation | null;
    }[];
  }, [feeExpenses, obligationByExpenseUser, obligations]);

  const guestFeeRows = useMemo(
    () => feeExpenses.filter((e) => isGuestFeeKey(e.period_key)),
    [feeExpenses]
  );

  const paidRows = useMemo(
    () =>
      memberFeeRows.filter(
        (r) => r.obligation?.status === 'paid' || (Number(r.obligation?.amount_paid) || 0) > 0
      ),
    [memberFeeRows]
  );
  const unpaidRows = useMemo(
    () =>
      memberFeeRows.filter(
        (r) =>
          !r.obligation ||
          (r.obligation.status !== 'paid' &&
            r.obligation.status !== 'waived' &&
            (Number(r.obligation.amount_paid) || 0) <= 0)
      ),
    [memberFeeRows]
  );

  const chargedUserIds = useMemo(() => {
    const set = new Set<string>();
    for (const r of memberFeeRows) set.add(r.userId);
    return set;
  }, [memberFeeRows]);

  const pendingEligible = useMemo(
    () => eligibleIds.filter((id) => id !== activity.created_by && !chargedUserIds.has(id)),
    [eligibleIds, chargedUserIds, activity.created_by]
  );

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
          const meta = await syncAttendeeFundingFees({ activity, settings });
          setFundingMeta({
            total: meta.total,
            perPerson: meta.perPerson,
            payerCount: meta.payerCount,
          });
          setEligibleIds(await resolveEligiblePayerIds(settings));
        } else {
          setFundingMeta(null);
          setEligibleIds([]);
        }
      } catch {
        setFinanceSettings(null);
        setFundingMeta(null);
        setEligibleIds([]);
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

      if (settings && Number(settings.amount) > 0) {
        const fees = exps.filter((e) => isFundingExpense(e));
        const total = Math.round(fees.reduce((s, e) => s + (Number(e.amount) || 0), 0) * 100) / 100;
        setFundingMeta({
          total,
          perPerson: Number(settings.amount) || 0,
          payerCount: fees.filter((e) => (e.period_key ?? '').startsWith('fee:') && !isGuestFeeKey(e.period_key))
            .length,
        });
      }

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
      setPaidBy(activity.created_by);
      setEditingFeeId(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : t.common.error;
      setError(/relation|does not exist|function|column/i.test(msg) ? t.finance.runSql : msg);
    } finally {
      setLoading(false);
    }
  }, [
    activity,
    attendees,
    applyPreset,
    sid,
    t.common.error,
    t.finance.runSql,
  ]);

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
    if (!paidBy) {
      Alert.alert(t.common.error, t.finance.needPayer);
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

  async function onTogglePaid(obl: ActivityObligation, paid: boolean) {
    if (!canManage) return;
    setBusy(true);
    try {
      await setObligationPaid(obl.id, paid);
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

  async function onDeleteFee(e: ExpenseWithMeta) {
    if (!canManage) return;
    const monthly = parseMonthlyFeeKey(e.period_key);
    if (!monthly) {
      await onDeleteExpense(e.id);
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
              await removeMonthlyFundingFee({
                seriesId: sid,
                expenseId: e.id,
                periodKey: e.period_key!,
                mode: 'this_month',
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
      {
        text: t.finance.stopFutureMonths,
        style: 'destructive',
        onPress: () => {
          void (async () => {
            setBusy(true);
            try {
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

  async function onSaveFeeAmount(expenseId: string) {
    if (!canManage) return;
    const n = Number(editFeeAmount.replace(',', '.'));
    if (!Number.isFinite(n) || n < 0) {
      Alert.alert(t.common.error, t.finance.needAmount);
      return;
    }
    setBusy(true);
    try {
      await updateExpenseAmount(expenseId, n);
      setEditingFeeId(null);
      await load();
    } catch (e) {
      Alert.alert(t.common.error, e instanceof Error ? e.message : t.common.error);
    } finally {
      setBusy(false);
    }
  }

  async function onChargeManually(personId: string) {
    if (!canManage || !financeSettings) return;
    setBusy(true);
    try {
      await createManualFundingFee({
        activity,
        settings: financeSettings,
        userId: personId,
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

          {financeSettings && Number(financeSettings.amount) > 0 ? (
            <View style={styles.card}>
              <Subtitle>{t.finance.participantFees}</Subtitle>
              <Muted>
                {t.finance.fundingSummary(
                  financeSettings.who_pays === 'group'
                    ? t.finance.whoPaysGroup
                    : t.finance.whoPaysSelected,
                  fundingMeta?.payerCount ?? memberFeeRows.length
                )}
              </Muted>
              <View style={styles.summaryRow}>
                <SummaryCard
                  label={t.finance.eventTotal}
                  value={`${budget.funded.toFixed(2)} €`}
                />
                <SummaryCard
                  label={t.finance.perPerson}
                  value={`${Number(financeSettings.amount).toFixed(2)} €`}
                />
              </View>
              <Muted>{t.finance.feesToBudget}</Muted>
            </View>
          ) : null}

          <View style={styles.card}>
            <Subtitle>{t.finance.whoPaid}</Subtitle>
            {!paidRows.length && !guestFeeRows.length ? (
              <Muted>{t.finance.nobodyPaidYet}</Muted>
            ) : null}
            {paidRows.map(({ expense: e, userId: uid, obligation: obl }) => (
              <FeePayRow
                key={e.id}
                name={displayName(profilesById.get(uid) ?? null)}
                amount={Number(obl?.amount_paid ?? e.amount)}
                paid
                canManage={canManage}
                busy={busy}
                editing={editingFeeId === e.id}
                editAmount={editFeeAmount}
                onEditAmount={setEditFeeAmount}
                onStartEdit={() => {
                  setEditingFeeId(e.id);
                  setEditFeeAmount(String(Number(e.amount)));
                }}
                onCancelEdit={() => setEditingFeeId(null)}
                onSaveEdit={() => void onSaveFeeAmount(e.id)}
                onDelete={() => void onDeleteFee(e)}
                onToggle={() => obl && void onTogglePaid(obl, false)}
                t={t}
              />
            ))}
            {guestFeeRows.map((e) => (
              <View key={e.id} style={styles.feeRow}>
                <Text style={styles.name}>{e.title}</Text>
                <Text style={styles.amount}>{Number(e.amount).toFixed(2)} €</Text>
                <Muted>{t.finance.guestIntoBudget}</Muted>
              </View>
            ))}
          </View>

          <View style={styles.card}>
            <Subtitle>{t.finance.whoHasntPaid}</Subtitle>
            {!unpaidRows.length && !pendingEligible.length ? (
              <Muted>{t.finance.allPaid}</Muted>
            ) : null}
            {unpaidRows.map(({ expense: e, userId: uid, obligation: obl }) => (
              <FeePayRow
                key={e.id}
                name={displayName(profilesById.get(uid) ?? null)}
                amount={Number(obl?.amount_due ?? e.amount)}
                paid={false}
                canManage={canManage}
                busy={busy}
                editing={editingFeeId === e.id}
                editAmount={editFeeAmount}
                onEditAmount={setEditFeeAmount}
                onStartEdit={() => {
                  setEditingFeeId(e.id);
                  setEditFeeAmount(String(Number(e.amount)));
                }}
                onCancelEdit={() => setEditingFeeId(null)}
                onSaveEdit={() => void onSaveFeeAmount(e.id)}
                onDelete={() => void onDeleteFee(e)}
                onToggle={() => obl && void onTogglePaid(obl, true)}
                t={t}
              />
            ))}
            {canManage && pendingEligible.length ? (
              <View style={{ marginTop: 8, gap: 6 }}>
                <Muted>{t.finance.eligiblePending}</Muted>
                {pendingEligible.map((id) => (
                  <View key={id} style={styles.feeRow}>
                    <Text style={styles.name}>{displayName(profilesById.get(id) ?? null)}</Text>
                    <Pressable disabled={busy} onPress={() => void onChargeManually(id)}>
                      <Text style={styles.link}>{t.finance.chargeManually}</Text>
                    </Pressable>
                  </View>
                ))}
              </View>
            ) : null}
          </View>

          {attendanceStats ? (
            <View style={styles.card}>
              <Subtitle>{t.finance.attendanceStats}</Subtitle>
              <Muted>{t.finance.uniqueAttendees(attendanceStats.uniqueAttendeeCount)}</Muted>
              {attendanceStats.memberAttendances.map((m) => (
                <Text key={m.userId} style={styles.statLine}>
                  {t.finance.memberStat(displayName(profilesById.get(m.userId) ?? null), m.count)}
                </Text>
              ))}
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

function FeePayRow({
  name,
  amount,
  paid,
  canManage,
  busy,
  editing,
  editAmount,
  onEditAmount,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  onDelete,
  onToggle,
  t,
}: {
  name: string;
  amount: number;
  paid: boolean;
  canManage: boolean;
  busy: boolean;
  editing: boolean;
  editAmount: string;
  onEditAmount: (v: string) => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onDelete: () => void;
  onToggle: () => void;
  t: ReturnType<typeof useT>;
}) {
  return (
    <View style={styles.feeRow}>
      <View style={styles.feeTop}>
        {canManage ? (
          <Pressable
            disabled={busy}
            onPress={onToggle}
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
        )}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.name}>{name}</Text>
          <Text style={styles.amount}>{amount.toFixed(2)} €</Text>
        </View>
      </View>
      {editing ? (
        <View style={{ gap: 6 }}>
          <Input
            label={t.finance.expenseAmount}
            value={editAmount}
            onChangeText={onEditAmount}
            keyboardType="decimal-pad"
          />
          <Button label={t.finance.saveFee} size="sm" loading={busy} onPress={onSaveEdit} />
          <Text style={styles.link} onPress={onCancelEdit}>
            {t.common.cancel}
          </Text>
        </View>
      ) : canManage ? (
        <View style={styles.feeActions}>
          <Pressable disabled={busy} onPress={onStartEdit}>
            <Text style={styles.link}>{t.finance.editFee}</Text>
          </Pressable>
          <Pressable disabled={busy} onPress={onDelete}>
            <Text style={styles.linkMuted}>{t.finance.deleteExpense}</Text>
          </Pressable>
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
  feeActions: { flexDirection: 'row', gap: 16, marginTop: 4 },
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
  checkReadonly: { opacity: 0.85 },
  checkMark: { color: '#fff', fontWeight: '800', fontSize: 14, lineHeight: 16 },
  error: { color: theme.colors.danger, fontWeight: '600' },
  statLine: { color: theme.colors.text, fontSize: 13, marginTop: 4 },
});
