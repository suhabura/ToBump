import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { Button, Chip, Input, Muted, Subtitle } from '@/components/ui';
import {
  computeBalances,
  createExpense,
  deleteExpense,
  ensureFundingExpenses,
  fetchActivityAttendeeIds,
  fetchSeriesExpenses,
  fetchSeriesFinanceSettings,
  fetchSeriesInviteeIds,
  fetchSeriesMemberProfiles,
  fetchSeriesSettlements,
  recordSettlement,
  seriesKey,
  suggestTransfers,
  type ExpenseWithMeta,
  type PersonBalance,
  type SuggestedTransfer,
} from '@/lib/finance';
import { fetchSeriesAttendanceStats } from '@/lib/guests';
import type { ActivityWithRelations, Profile, SeriesFinanceSettings } from '@/lib/types';
import { displayName } from '@/lib/types';
import { useT } from '@/i18n';
import { theme } from '@/constants/theme';

type Props = {
  activity: ActivityWithRelations;
  userId: string;
  canManage: boolean;
  attendees: Profile[];
};

type Tab = 'balances' | 'expenses';
type SplitPreset = 'invitees' | 'attendees' | 'custom';

export function ActivityFinancePanel({ activity, userId, canManage, attendees }: Props) {
  const t = useT();
  const sid = seriesKey(activity);
  const [tab, setTab] = useState<Tab>('balances');
  const [expenses, setExpenses] = useState<ExpenseWithMeta[]>([]);
  const [members, setMembers] = useState<Profile[]>([]);
  const [inviteeIds, setInviteeIds] = useState<string[]>([]);
  const [attendeeIds, setAttendeeIds] = useState<string[]>([]);
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

  const [showAdd, setShowAdd] = useState(false);
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [paidBy, setPaidBy] = useState(userId);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const profilesById = useMemo(() => {
    const map = new Map(members.map((m) => [m.id, m]));
    for (const a of attendees) map.set(a.id, a);
    return map;
  }, [members, attendees]);

  const [settlements, setSettlements] = useState<Awaited<ReturnType<typeof fetchSeriesSettlements>>>([]);

  const balances = useMemo(
    () => computeBalances(expenses, settlements, profilesById),
    [expenses, settlements, profilesById]
  );
  const transfers = useMemo(() => suggestTransfers(balances), [balances]);
  const totalSpent = useMemo(
    () => expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0),
    [expenses]
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
      let meta: { total: number; perPerson: number; payerCount: number } | null = null;
      try {
        settings = await fetchSeriesFinanceSettings(sid);
        setFinanceSettings(settings);
        if (settings && activity.finance_enabled) {
          meta = await ensureFundingExpenses({ activity, settings });
          setFundingMeta({
            total: meta.total,
            perPerson: meta.perPerson,
            payerCount: meta.payerCount,
          });
        } else {
          setFundingMeta(null);
        }
      } catch {
        setFinanceSettings(null);
        setFundingMeta(null);
      }

      const [exps, mems, settles, invites, attendeesForEvent, stats] = await Promise.all([
        fetchSeriesExpenses(sid),
        fetchSeriesMemberProfiles(sid),
        fetchSeriesSettlements(sid),
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
      setMembers(people);
      setInviteeIds(uniqueInvites);
      setAttendeeIds(attendeesForEvent);
      setSettlements(settles);
      setAttendanceStats(stats);

      if (settings && Number(settings.amount) > 0) {
        const who = settings.who_pays === 'attendees' ? 'attendees' : 'invitees';
        const rawIds =
          who === 'attendees'
            ? attendeesForEvent.length
              ? attendeesForEvent
              : uniqueInvites
            : uniqueInvites;
        const n = Math.max(1, rawIds.filter((id) => id !== activity.created_by).length || rawIds.length);
        const perPerson = Number(settings.amount) || 0;
        setFundingMeta({
          total: Math.round(perPerson * n * 100) / 100,
          perPerson,
          payerCount: n,
        });
      }

      setSelectedIds((prev) => {
        if (prev.length) return prev.filter((id) => people.some((p) => p.id === id));
        return uniqueInvites.filter((id) => people.some((p) => p.id === id)).length
          ? uniqueInvites.filter((id) => people.some((p) => p.id === id))
          : people.map((p) => p.id);
      });
      applyPreset(
        settings?.who_pays === 'attendees' ? 'attendees' : 'invitees',
        uniqueInvites,
        attendeesForEvent,
        people
      );
      setPaidBy(activity.created_by);
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
    const n = Number(amount.replace(',', '.'));
    if (!title.trim()) {
      Alert.alert(t.common.error, t.finance.needTitle);
      return;
    }
    if (!Number.isFinite(n) || n <= 0) {
      Alert.alert(t.common.error, t.finance.needAmount);
      return;
    }
    if (!selectedIds.length) {
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
        splitMode: splitPreset === 'attendees' ? 'equal_attendees' : splitPreset === 'invitees' ? 'equal_all' : 'selected',
        memberIds: selectedIds,
        paidBy,
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

  async function onSettle(tr: SuggestedTransfer) {
    setBusy(true);
    try {
      await recordSettlement({
        seriesId: sid,
        fromUserId: tr.fromUserId,
        toUserId: tr.toUserId,
        amount: tr.amount,
      });
      await load();
    } catch (e) {
      Alert.alert(t.common.error, e instanceof Error ? e.message : t.common.error);
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteExpense(id: string) {
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

  if (loading) return <Muted>{t.common.loading}</Muted>;
  if (error) return <Text style={styles.error}>{error}</Text>;

  return (
    <View style={{ gap: 12 }}>
      <View style={styles.summaryRow}>
        <SummaryCard label={t.finance.totalSpent} value={`${totalSpent.toFixed(2)} €`} />
        <SummaryCard label={t.finance.expenses} value={String(expenses.length)} />
      </View>

      {financeSettings && fundingMeta && Number(financeSettings.amount) > 0 ? (
        <View style={styles.card}>
          <Subtitle>{t.finance.whoPays}</Subtitle>
          <Muted>
            {t.finance.fundingSummary(
              financeSettings.who_pays === 'attendees'
                ? t.finance.whoPaysAttendees
                : t.finance.whoPaysInvitees,
              fundingMeta.payerCount
            )}
          </Muted>
          <View style={styles.summaryRow}>
            <SummaryCard
              label={t.finance.eventTotal}
              value={`${fundingMeta.total.toFixed(2)} €`}
            />
            <SummaryCard
              label={t.finance.perPerson}
              value={`${fundingMeta.perPerson.toFixed(2)} €`}
            />
          </View>
          <Muted>{t.finance.paysOrganizer}</Muted>
        </View>
      ) : null}

      {attendanceStats ? (
        <View style={styles.card}>
          <Subtitle>{t.finance.attendanceStats}</Subtitle>
          <Muted>{t.finance.uniqueAttendees(attendanceStats.uniqueAttendeeCount)}</Muted>
          {attendanceStats.memberAttendances.map((m) => (
            <Text key={m.userId} style={styles.statLine}>
              {t.finance.memberStat(
                displayName(profilesById.get(m.userId) ?? null),
                m.count
              )}
            </Text>
          ))}
          {attendanceStats.guestAttendances.map((g) => (
            <Text key={g.guestId} style={styles.statLine}>
              {t.finance.guestStat(g.name, g.count, g.totalPaid)}
            </Text>
          ))}
        </View>
      ) : null}

      <View style={styles.tabRow}>
        <Chip label={t.finance.balances} active={tab === 'balances'} onPress={() => setTab('balances')} />
        <Chip label={t.finance.expenses} active={tab === 'expenses'} onPress={() => setTab('expenses')} />
      </View>

      {!showAdd ? (
        <Button label={t.finance.addExpense} onPress={() => setShowAdd(true)} />
      ) : (
        <View style={styles.card}>
          <Subtitle>{t.finance.addExpense}</Subtitle>
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
            {members.map((m) => (
              <Chip
                key={m.id}
                label={displayName(m)}
                active={paidBy === m.id}
                onPress={() => setPaidBy(m.id)}
              />
            ))}
          </View>
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
          <Button label={t.finance.createExpense} onPress={onAddExpense} loading={busy} />
          <Text style={[styles.link, { marginTop: 4 }]} onPress={() => setShowAdd(false)}>
            {t.common.cancel}
          </Text>
        </View>
      )}

      {tab === 'balances' ? (
        <BalancesView
          balances={balances}
          transfers={transfers}
          userId={userId}
          busy={busy}
          onSettle={onSettle}
          t={t}
        />
      ) : (
        <ExpensesView
          expenses={expenses}
          userId={userId}
          canManage={canManage}
          busy={busy}
          onDelete={onDeleteExpense}
          t={t}
        />
      )}
    </View>
  );
}

function BalancesView({
  balances,
  transfers,
  userId,
  busy,
  onSettle,
  t,
}: {
  balances: PersonBalance[];
  transfers: SuggestedTransfer[];
  userId: string;
  busy: boolean;
  onSettle: (tr: SuggestedTransfer) => void;
  t: ReturnType<typeof useT>;
}) {
  if (!balances.length) {
    return <Muted>{t.finance.allSettled}</Muted>;
  }

  return (
    <View style={{ gap: 12 }}>
      <Subtitle>{t.finance.balances}</Subtitle>
      {balances.map((b) => {
        const name = displayName(b.profile);
        const isMe = b.userId === userId;
        const label =
          b.net > 0
            ? isMe
              ? t.finance.youAreOwed(b.net)
              : t.finance.isOwed(name, b.net)
            : isMe
              ? t.finance.youOwe(Math.abs(b.net))
              : t.finance.owes(name, Math.abs(b.net));
        return (
          <View key={b.userId} style={styles.card}>
            <Text style={[styles.name, b.net > 0 ? styles.positive : styles.negative]}>{label}</Text>
          </View>
        );
      })}

      <Subtitle>{t.finance.settleUp}</Subtitle>
      {!transfers.length ? <Muted>{t.finance.allSettled}</Muted> : null}
      {transfers.map((tr) => {
        const from = displayName(tr.fromProfile);
        const to = displayName(tr.toProfile);
        const involvesMe = tr.fromUserId === userId || tr.toUserId === userId;
        return (
          <View key={`${tr.fromUserId}-${tr.toUserId}-${tr.amount}`} style={styles.card}>
            <Text style={styles.itemLabel}>
              {t.finance.shouldPay(from, to, tr.amount)}
            </Text>
            {involvesMe ? (
              <Pressable disabled={busy} onPress={() => onSettle(tr)}>
                <Text style={styles.link}>{t.finance.markSettled}</Text>
              </Pressable>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

function ExpensesView({
  expenses,
  userId,
  canManage,
  busy,
  onDelete,
  t,
}: {
  expenses: ExpenseWithMeta[];
  userId: string;
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
        const payerName = displayName(e.payer ?? null);
        const n = (e.members ?? []).length || 1;
        const share = (Number(e.amount) || 0) / n;
        const canDelete = canManage || e.created_by === userId;
        return (
          <View key={e.id} style={styles.card}>
            <Text style={styles.name}>{e.title}</Text>
            <Text style={styles.amount}>{Number(e.amount).toFixed(2)} €</Text>
            <Muted>
              {t.finance.paidByName(payerName)} · {t.finance.splitN(n, share)}
            </Muted>
            {canDelete ? (
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
  itemLabel: { color: theme.colors.text, fontWeight: '600' },
  positive: { color: theme.colors.success },
  negative: { color: theme.colors.danger },
  link: { color: theme.colors.primary, fontWeight: '700' },
  linkMuted: { color: theme.colors.textMuted, fontWeight: '600', fontSize: 13 },
  error: { color: theme.colors.danger, fontWeight: '600' },
  statLine: { color: theme.colors.text, fontSize: 13, marginTop: 4 },
});
