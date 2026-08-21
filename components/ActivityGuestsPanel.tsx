import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { Button, Chip, Input, Muted, Subtitle } from '@/components/ui';
import {
  addGuestToActivity,
  fetchActivityGuests,
  fetchSeriesGuests,
  removeGuestAttendance,
  type GuestAttendanceWithGuest,
  type SeriesGuestWithStats,
} from '@/lib/guests';
import { fetchSeriesInviteeIds, seriesKey } from '@/lib/finance';
import type { ActivityWithRelations, GuestFeeTreatment } from '@/lib/types';
import { useT } from '@/i18n';
import { theme } from '@/constants/theme';

type Props = {
  activity: ActivityWithRelations;
  canManage: boolean;
  onChanged?: () => void;
};

export function ActivityGuestsPanel({ activity, canManage, onChanged }: Props) {
  const t = useT();
  const sid = seriesKey(activity);
  const [attendances, setAttendances] = useState<GuestAttendanceWithGuest[]>([]);
  const [seriesGuests, setSeriesGuests] = useState<SeriesGuestWithStats[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState('');
  const [isFree, setIsFree] = useState(true);
  const [amount, setAmount] = useState('');
  const [feeTreatment, setFeeTreatment] = useState<GuestFeeTreatment>('split_all');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [atts, series] = await Promise.all([
        fetchActivityGuests(activity.id),
        fetchSeriesGuests(sid),
      ]);
      setAttendances(atts);
      const here = new Set(atts.map((a) => a.guest_id));
      setSeriesGuests(series.map((g) => ({ ...g, attended_this: here.has(g.id) })));
    } catch (e) {
      const msg = e instanceof Error ? e.message : t.common.error;
      setError(/relation|does not exist|function/i.test(msg) ? t.guests.runSql : msg);
    } finally {
      setLoading(false);
    }
  }, [activity.id, sid, t.common.error, t.guests.runSql]);

  useEffect(() => {
    load();
  }, [load]);

  async function submitGuest(guestName: string) {
    const n = guestName.trim();
    if (!n) {
      Alert.alert(t.common.error, t.guests.needName);
      return;
    }
    let pay = 0;
    if (!isFree) {
      pay = Number(String(amount).replace(',', '.'));
      if (!Number.isFinite(pay) || pay <= 0) {
        Alert.alert(t.common.error, t.guests.needAmount);
        return;
      }
    }
    setBusy(true);
    try {
      const memberIds = await fetchSeriesInviteeIds(sid);
      await addGuestToActivity({
        activityId: activity.id,
        name: n,
        amount: pay,
        feeTreatment: !isFree
          ? activity.is_recurring || activity.finance_enabled
            ? feeTreatment
            : 'none'
          : 'none',
        memberIds,
      });
      setName('');
      setAmount('');
      setIsFree(true);
      setShowAdd(false);
      await load();
      onChanged?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : t.common.error;
      Alert.alert(
        t.common.error,
        /already added/i.test(msg) ? t.guests.alreadyAdded : msg
      );
    } finally {
      setBusy(false);
    }
  }

  async function onRemove(attendanceId: string) {
    setBusy(true);
    try {
      await removeGuestAttendance(attendanceId);
      await load();
      onChanged?.();
    } catch (e) {
      Alert.alert(t.common.error, e instanceof Error ? e.message : t.common.error);
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Muted>{t.common.loading}</Muted>;
  if (error) return <Text style={styles.error}>{error}</Text>;

  const knownNotHere = seriesGuests.filter((g) => !g.attended_this);

  return (
    <View style={{ gap: 10, marginTop: 8 }}>
      <View style={styles.headerRow}>
        <Subtitle>{t.guests.title}</Subtitle>
        {canManage ? (
          <Text style={styles.link} onPress={() => setShowAdd((v) => !v)}>
            {showAdd ? t.common.cancel : t.guests.add}
          </Text>
        ) : null}
      </View>
      <Muted>{t.guests.hint}</Muted>

      {attendances.length === 0 ? <Muted>{t.guests.empty}</Muted> : null}
      {attendances.map((a) => {
        const gName = a.activity_guests?.name ?? '—';
        return (
          <View key={a.id} style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>
                {gName} <Text style={styles.guestTag}>({t.guests.guest})</Text>
              </Text>
              <Muted>
                {a.is_free
                  ? t.guests.free
                  : t.guests.pays(Number(a.amount))}
                {!a.is_free && a.fee_treatment === 'split_all'
                  ? ` · ${t.guests.splitAll}`
                  : ''}
              </Muted>
            </View>
            {canManage ? (
              <Pressable onPress={() => onRemove(a.id)} disabled={busy}>
                <Text style={styles.remove}>{t.guests.remove}</Text>
              </Pressable>
            ) : null}
          </View>
        );
      })}

      {canManage && knownNotHere.length > 0 ? (
        <View style={{ gap: 6 }}>
          <Muted>{t.guests.seriesGuests}</Muted>
          <View style={styles.chipRow}>
            {knownNotHere.map((g) => (
              <Chip
                key={g.id}
                label={`${g.name} (${g.attendance_count}×)`}
                onPress={() => {
                  setName(g.name);
                  setShowAdd(true);
                }}
              />
            ))}
          </View>
        </View>
      ) : null}

      {canManage && showAdd ? (
        <View style={styles.form}>
          <Input label={t.guests.name} value={name} onChangeText={setName} placeholder={t.guests.nameHint} />
          <Muted>{t.guests.payment}</Muted>
          <View style={styles.chipRow}>
            <Chip label={t.guests.free} active={isFree} onPress={() => setIsFree(true)} />
            <Chip label={t.guests.paysAmount} active={!isFree} onPress={() => setIsFree(false)} />
          </View>
          {!isFree ? (
            <>
              <Input
                label={t.guests.amount}
                value={amount}
                onChangeText={setAmount}
                keyboardType="decimal-pad"
              />
              {(activity.is_recurring || activity.finance_enabled) ? (
                <>
                  <Muted>{t.guests.feeMeaning}</Muted>
                  <View style={styles.chipRow}>
                    <Chip
                      label={t.guests.splitAll}
                      active={feeTreatment === 'split_all'}
                      onPress={() => setFeeTreatment('split_all')}
                    />
                    <Chip
                      label={t.guests.feeRecordOnly}
                      active={feeTreatment === 'none'}
                      onPress={() => setFeeTreatment('none')}
                    />
                  </View>
                </>
              ) : null}
            </>
          ) : null}
          <Button label={t.guests.save} onPress={() => submitGuest(name)} loading={busy} icon="user-plus" />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  link: { color: theme.colors.primary, fontWeight: '700' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: 12,
  },
  name: { fontWeight: '700', color: theme.colors.text, fontSize: 15 },
  guestTag: { fontWeight: '600', color: theme.colors.textMuted, fontSize: 13 },
  remove: { color: theme.colors.danger, fontWeight: '600', fontSize: 13 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  form: {
    gap: 8,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.space.md,
  },
  error: { color: theme.colors.danger, fontWeight: '600' },
});
