import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { Button, Chip, Input, Muted, Subtitle } from '@/components/ui';
import { FriendPicker } from '@/components/FriendPicker';
import {
  createExpense,
  currentMonthKey,
  currentYearKey,
  fetchActivityAttendeeIds,
  fetchSeriesFinanceSettings,
  fetchSeriesMemberProfiles,
  fetchSeriesObligations,
  generateMembershipObligations,
  groupDebtors,
  recordPayment,
  seriesKey,
  settlePerEventOccurrence,
  summarizeFinance,
  upsertSeriesFinanceSettings,
  waiveObligation,
  type ObligationWithMeta,
} from '@/lib/finance';
import type {
  ActivityWithRelations,
  FundingMode,
  Profile,
  SeriesFinanceSettings,
  SplitMode,
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

export function ActivityFinancePanel({ activity, userId, canManage, attendees }: Props) {
  const t = useT();
  const sid = seriesKey(activity);
  const [settings, setSettings] = useState<SeriesFinanceSettings | null>(null);
  const [mode, setMode] = useState<FundingMode>('per_event');
  const [amount, setAmount] = useState('40');
  const [obligations, setObligations] = useState<ObligationWithMeta[]>([]);
  const [members, setMembers] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [manualTitle, setManualTitle] = useState('');
  const [manualAmount, setManualAmount] = useState('');
  const [splitMode, setSplitMode] = useState<SplitMode>('equal_all');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [showManual, setShowManual] = useState(false);

  const summary = useMemo(() => summarizeFinance(obligations), [obligations]);
  const debtors = useMemo(() => groupDebtors(obligations), [obligations]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [s, obs, mems] = await Promise.all([
        fetchSeriesFinanceSettings(sid),
        fetchSeriesObligations(sid),
        fetchSeriesMemberProfiles(sid),
      ]);
      setSettings(s);
      if (s) {
        setMode(s.funding_mode);
        setAmount(String(s.amount));
      }
      setObligations(obs);
      setMembers(mems.length ? mems : attendees);
    } catch (e) {
      const msg = e instanceof Error ? e.message : t.common.error;
      setError(/relation|does not exist|function/i.test(msg) ? t.finance.runSql : msg);
    } finally {
      setLoading(false);
    }
  }, [sid, attendees, t.common.error, t.finance.runSql]);

  useEffect(() => {
    load();
  }, [load]);

  async function saveSettings() {
    const n = Number(amount);
    if (!Number.isFinite(n) || n < 0) {
      Alert.alert(t.common.error, t.finance.needAmount);
      return;
    }
    setBusy(true);
    try {
      await upsertSeriesFinanceSettings({
        seriesId: sid,
        fundingMode: mode,
        amount: n,
        userId,
      });
      Alert.alert('OK', t.finance.settingsSaved);
      load();
    } catch (e) {
      Alert.alert(t.common.error, e instanceof Error ? e.message : t.common.error);
    } finally {
      setBusy(false);
    }
  }

  async function onSettleEvent() {
    const fee = Number(settings?.amount ?? amount);
    if (!Number.isFinite(fee) || fee < 0) {
      Alert.alert(t.common.error, t.finance.needAmount);
      return;
    }
    setBusy(true);
    try {
      const ids = await fetchActivityAttendeeIds(activity.id);
      if (!ids.length) throw new Error(t.finance.needMembers);
      await settlePerEventOccurrence({
        seriesId: sid,
        activityId: activity.id,
        amount: fee,
        title: activity.title,
        attendeeIds: ids,
      });
      Alert.alert('OK', t.finance.settled);
      load();
    } catch (e) {
      Alert.alert(t.common.error, e instanceof Error ? e.message : t.common.error);
    } finally {
      setBusy(false);
    }
  }

  async function onGeneratePeriod() {
    const fee = Number(settings?.amount ?? amount);
    if (!Number.isFinite(fee) || fee < 0) {
      Alert.alert(t.common.error, t.finance.needAmount);
      return;
    }
    const memberIds = members.map((m) => m.id);
    if (!memberIds.length) {
      Alert.alert(t.common.error, t.finance.needMembers);
      return;
    }
    const isMonthly = (settings?.funding_mode ?? mode) === 'monthly';
    const periodKey = isMonthly ? currentMonthKey() : currentYearKey();
    setBusy(true);
    try {
      await generateMembershipObligations({
        seriesId: sid,
        mode: isMonthly ? 'monthly' : 'annual',
        feePerMember: fee,
        memberIds,
        periodKey,
        title: isMonthly ? `${t.finance.monthly} ${periodKey}` : `${t.finance.annual} ${periodKey}`,
        dueDate: isMonthly ? `${periodKey}-28` : `${periodKey}-12-31`,
      });
      Alert.alert('OK', t.finance.generated);
      load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : t.common.error;
      Alert.alert(
        t.common.error,
        /already generated/i.test(msg) ? t.finance.alreadyGenerated : msg
      );
    } finally {
      setBusy(false);
    }
  }

  async function onCreateManual() {
    const n = Number(manualAmount);
    if (!manualTitle.trim()) {
      Alert.alert(t.common.error, t.finance.needTitle);
      return;
    }
    if (!Number.isFinite(n) || n <= 0) {
      Alert.alert(t.common.error, t.finance.needAmount);
      return;
    }
    let memberIds: string[] = [];
    if (splitMode === 'equal_attendees') {
      memberIds = await fetchActivityAttendeeIds(activity.id);
    } else if (splitMode === 'selected') {
      memberIds = selectedIds;
    } else {
      memberIds = members.map((m) => m.id);
    }
    if (!memberIds.length) {
      Alert.alert(t.common.error, t.finance.needMembers);
      return;
    }
    setBusy(true);
    try {
      await createExpense({
        seriesId: sid,
        expenseType: 'manual',
        title: manualTitle.trim(),
        amount: n,
        splitMode,
        memberIds,
        activityId: activity.id,
      });
      setManualTitle('');
      setManualAmount('');
      setShowManual(false);
      Alert.alert('OK', t.finance.expenseCreated);
      load();
    } catch (e) {
      Alert.alert(t.common.error, e instanceof Error ? e.message : t.common.error);
    } finally {
      setBusy(false);
    }
  }

  async function onMarkPaid(obligationId: string, openAmount: number) {
    if (openAmount <= 0) return;
    setBusy(true);
    try {
      await recordPayment(obligationId, openAmount);
      load();
    } catch (e) {
      Alert.alert(t.common.error, e instanceof Error ? e.message : t.common.error);
    } finally {
      setBusy(false);
    }
  }

  async function onWaive(id: string) {
    setBusy(true);
    try {
      await waiveObligation(id);
      load();
    } catch (e) {
      Alert.alert(t.common.error, e instanceof Error ? e.message : t.common.error);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Muted>{t.common.loading}</Muted>;
  if (error) return <Text style={styles.error}>{error}</Text>;

  const activeMode = settings?.funding_mode ?? mode;

  return (
    <View style={{ gap: 12 }}>
      <View style={styles.summaryRow}>
        <SummaryCard label={t.finance.totalCosts} value={`${summary.totalCosts.toFixed(2)} €`} />
        <SummaryCard label={t.finance.paid} value={`${summary.paid.toFixed(2)} €`} />
        <SummaryCard label={t.finance.unpaid} value={`${summary.unpaid.toFixed(2)} €`} />
      </View>
      <Muted>{t.finance.debtorCount(summary.debtorCount)}</Muted>

      {canManage ? (
        <View style={styles.card}>
          <Subtitle>{t.finance.fundingMode}</Subtitle>
          <View style={styles.rowWrap}>
            {(
              [
                ['per_event', t.finance.perEvent],
                ['monthly', t.finance.monthly],
                ['annual', t.finance.annual],
              ] as const
            ).map(([key, label]) => (
              <Chip key={key} label={label} active={mode === key} onPress={() => setMode(key)} />
            ))}
          </View>
          <Input
            label={t.finance.amount}
            value={amount}
            onChangeText={setAmount}
            keyboardType="decimal-pad"
          />
          <Button label={t.finance.saveSettings} onPress={saveSettings} loading={busy} />

          {activeMode === 'per_event' ? (
            <View style={{ marginTop: 8 }}>
              <Muted>{t.finance.settleHint}</Muted>
              <Button label={t.finance.settleEvent} variant="secondary" onPress={onSettleEvent} loading={busy} />
            </View>
          ) : null}
          {activeMode === 'monthly' ? (
            <Button
              label={t.finance.generateMonth}
              variant="secondary"
              onPress={onGeneratePeriod}
              loading={busy}
            />
          ) : null}
          {activeMode === 'annual' ? (
            <Button
              label={t.finance.generateYear}
              variant="secondary"
              onPress={onGeneratePeriod}
              loading={busy}
            />
          ) : null}
        </View>
      ) : null}

      {canManage ? (
        <View style={styles.card}>
          {!showManual ? (
            <Text style={styles.link} onPress={() => setShowManual(true)}>
              {t.finance.manualExpense}
            </Text>
          ) : (
            <View>
              <Subtitle>{t.finance.manualExpense}</Subtitle>
              <Input
                label={t.finance.expenseTitle}
                value={manualTitle}
                onChangeText={setManualTitle}
                placeholder="e.g. New net"
              />
              <Input
                label={t.finance.expenseAmount}
                value={manualAmount}
                onChangeText={setManualAmount}
                keyboardType="decimal-pad"
              />
              <View style={styles.rowWrap}>
                <Chip
                  label={t.finance.splitEqualAll}
                  active={splitMode === 'equal_all'}
                  onPress={() => setSplitMode('equal_all')}
                />
                <Chip
                  label={t.finance.splitAttendees}
                  active={splitMode === 'equal_attendees'}
                  onPress={() => setSplitMode('equal_attendees')}
                />
                <Chip
                  label={t.finance.splitSelected}
                  active={splitMode === 'selected'}
                  onPress={() => setSplitMode('selected')}
                />
              </View>
              {splitMode === 'selected' ? (
                <FriendPicker
                  friends={members}
                  selectedIds={selectedIds}
                  onChange={setSelectedIds}
                  label={t.finance.splitSelected}
                  placeholder={t.form.searchFriends}
                />
              ) : null}
              <Button label={t.finance.createExpense} onPress={onCreateManual} loading={busy} />
              <Text style={[styles.link, { marginTop: 8 }]} onPress={() => setShowManual(false)}>
                {t.common.cancel}
              </Text>
            </View>
          )}
        </View>
      ) : null}

      <Subtitle>{t.finance.debtors}</Subtitle>
      {debtors.length === 0 ? <Muted>{t.finance.noDebtors}</Muted> : null}
      {debtors.map((d) => (
        <View key={d.userId} style={styles.card}>
          <Text style={styles.name}>{displayName(d.profile)}</Text>
          {d.items.map((item) => (
            <View key={item.obligationId} style={styles.debtRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.itemLabel}>{item.label}</Text>
                <Muted>
                  {item.amount.toFixed(2)} € · {statusLabel(item.status, t)}
                </Muted>
              </View>
              {canManage ? (
                <View style={{ gap: 4 }}>
                  <Pressable onPress={() => onMarkPaid(item.obligationId, item.amount)}>
                    <Text style={styles.link}>{t.finance.markPaid}</Text>
                  </Pressable>
                  <Pressable onPress={() => onWaive(item.obligationId)}>
                    <Text style={styles.linkMuted}>{t.finance.waive}</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          ))}
          <Text style={styles.total}>
            {t.finance.together}: {d.totalOpen.toFixed(2)} €
          </Text>
        </View>
      ))}
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

function statusLabel(status: string, t: ReturnType<typeof useT>) {
  switch (status) {
    case 'paid':
      return t.finance.statusPaid;
    case 'partial':
      return t.finance.statusPartial;
    case 'waived':
      return t.finance.statusWaived;
    default:
      return t.finance.statusUnpaid;
  }
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
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.space.md,
    gap: 8,
  },
  rowWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  name: { fontWeight: '700', fontSize: 16, color: theme.colors.text },
  debtRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 },
  itemLabel: { color: theme.colors.text, fontWeight: '600' },
  total: { marginTop: 8, fontWeight: '800', color: theme.colors.primary },
  link: { color: theme.colors.primary, fontWeight: '700' },
  linkMuted: { color: theme.colors.textMuted, fontWeight: '600', fontSize: 13 },
  error: { color: theme.colors.danger, fontWeight: '600' },
});
