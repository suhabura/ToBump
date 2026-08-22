import { useCallback, useEffect, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { Button, Chip, Input, Muted, Subtitle } from '@/components/ui';
import {
  addGuestToActivity,
  fetchSeriesGuests,
  type GuestAttendanceWithGuest,
  type SeriesGuestWithStats,
} from '@/lib/guests';
import { seriesKey } from '@/lib/finance';
import type { ActivityWithRelations } from '@/lib/types';
import { useT } from '@/i18n';
import { theme } from '@/constants/theme';

type Props = {
  activity: ActivityWithRelations;
  canManage: boolean;
  guestsOnEvent?: GuestAttendanceWithGuest[];
  onChanged?: () => void;
};

export function ActivityGuestsPanel({ activity, canManage, guestsOnEvent = [], onChanged }: Props) {
  const t = useT();
  const sid = seriesKey(activity);
  const [seriesGuests, setSeriesGuests] = useState<SeriesGuestWithStats[]>([]);
  const [busy, setBusy] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState('');
  const [isFree, setIsFree] = useState(true);
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);

  const hereIds = new Set(guestsOnEvent.map((a) => a.guest_id));

  const loadSeries = useCallback(async () => {
    setError(null);
    try {
      const series = await fetchSeriesGuests(sid);
      setSeriesGuests(series.map((g) => ({ ...g, attended_this: hereIds.has(g.id) })));
    } catch (e) {
      const msg = e instanceof Error ? e.message : t.common.error;
      setError(/relation|does not exist|function/i.test(msg) ? t.guests.runSql : msg);
    }
  }, [sid, t.common.error, t.guests.runSql, guestsOnEvent]);

  useEffect(() => {
    if (canManage) void loadSeries();
  }, [canManage, loadSeries]);

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
      await addGuestToActivity({
        activityId: activity.id,
        name: n,
        amount: pay,
        feeTreatment: !isFree ? 'to_budget' : 'none',
      });
      setName('');
      setAmount('');
      setIsFree(true);
      setShowAdd(false);
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

  if (!canManage) return null;
  if (error) return <Text style={styles.error}>{error}</Text>;

  const knownNotHere = seriesGuests.filter((g) => !g.attended_this);

  return (
    <View style={{ gap: 10, marginTop: 16 }}>
      <View style={styles.headerRow}>
        <Subtitle>{t.guests.title}</Subtitle>
        <Text style={styles.link} onPress={() => setShowAdd((v) => !v)}>
          {showAdd ? t.common.cancel : t.guests.add}
        </Text>
      </View>
      <Muted>{t.guests.hint}</Muted>

      {knownNotHere.length > 0 ? (
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

      {showAdd ? (
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
              <Muted>{t.guests.toBudgetHint}</Muted>
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
