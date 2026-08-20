import { format } from 'date-fns';
import { enUS, sl as slLocale } from 'date-fns/locale';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { EmptyState, Loading, Muted, Screen, Subtitle, Title } from '@/components/ui';
import { useAuth } from '@/contexts/AuthContext';
import { fetchMyFinance, obligationOpenAmount, type PersonalFinance } from '@/lib/finance';
import { useLocale, useT } from '@/i18n';
import { theme } from '@/constants/theme';

export default function MyPaymentsScreen() {
  const t = useT();
  const { locale } = useLocale();
  const { user } = useAuth();
  const router = useRouter();
  const [data, setData] = useState<PersonalFinance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const dfLocale = locale === 'sl' ? slLocale : enUS;

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      setData(await fetchMyFinance(user.id));
    } catch (e) {
      const msg = e instanceof Error ? e.message : t.common.error;
      setError(/relation|does not exist|function/i.test(msg) ? t.finance.runSql : msg);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [user, t.common.error, t.finance.runSql]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  if (loading) return <Loading />;

  return (
    <Screen>
      <Title>{t.finance.myPayments}</Title>
      {error ? <Text style={styles.error}>{error}</Text> : null}

      {data ? (
        <View style={styles.summary}>
          <View style={styles.card}>
            <Muted>{t.finance.paidThisYear}</Muted>
            <Text style={styles.value}>{data.paidThisYear.toFixed(2)} €</Text>
          </View>
          <View style={styles.card}>
            <Muted>{t.finance.openObligations}</Muted>
            <Text style={styles.value}>{data.openAmount.toFixed(2)} €</Text>
          </View>
          <View style={styles.card}>
            <Muted>{t.finance.nextDue}</Muted>
            <Text style={styles.value}>
              {data.nextDueDate
                ? format(new Date(`${data.nextDueDate}T12:00:00`), 'd MMM yyyy', { locale: dfLocale })
                : '—'}
            </Text>
          </View>
        </View>
      ) : null}

      <Subtitle>{t.finance.open}</Subtitle>
      {!data?.obligations.length ? <EmptyState title={t.finance.noObligations} /> : null}
      {data?.obligations.map((o) => {
        const open = obligationOpenAmount(o);
        if (open <= 0.001 && o.status !== 'waived') return null;
        return (
          <View key={o.id} style={styles.row}>
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{o.activity_expenses?.title ?? '—'}</Text>
              <Muted>
                {open.toFixed(2)} € ·{' '}
                {o.status === 'waived'
                  ? t.finance.statusWaived
                  : o.status === 'partial'
                    ? t.finance.statusPartial
                    : o.status === 'paid'
                      ? t.finance.statusPaid
                      : t.finance.statusUnpaid}
                {o.due_date
                  ? ` · ${format(new Date(`${o.due_date}T12:00:00`), 'd MMM yyyy', { locale: dfLocale })}`
                  : ''}
              </Muted>
            </View>
          </View>
        );
      })}

      <Text style={styles.back} onPress={() => router.back()}>
        {t.common.cancel}
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  summary: { gap: 8, marginVertical: 12 },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.space.md,
  },
  value: { fontSize: 20, fontWeight: '800', color: theme.colors.text, marginTop: 4 },
  row: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.space.md,
    marginBottom: 8,
  },
  name: { fontWeight: '700', color: theme.colors.text },
  error: { color: theme.colors.danger, fontWeight: '600', marginVertical: 8 },
  back: { marginTop: 16, color: theme.colors.primary, fontWeight: '700' },
});
