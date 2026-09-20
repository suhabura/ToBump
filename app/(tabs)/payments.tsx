import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import FontAwesome from '@expo/vector-icons/FontAwesome';
import { EmptyState, Loading, Muted, Screen, Subtitle, Title } from '@/components/ui';
import { useAuth } from '@/contexts/AuthContext';
import { fetchMyFinance, type PersonalFinance } from '@/lib/finance';
import { useT } from '@/i18n';
import { theme } from '@/constants/theme';

export default function MyPaymentsScreen() {
  const t = useT();
  const { user } = useAuth();
  const router = useRouter();
  const [data, setData] = useState<PersonalFinance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      setData(await fetchMyFinance(user.id));
    } catch (e) {
      const msg = e instanceof Error ? e.message : t.common.error;
      setError(/relation|does not exist|function|column/i.test(msg) ? t.finance.runSql : msg);
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
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
      <Title>{t.finance.myPayments}</Title>
      {error ? <Text style={styles.error}>{error}</Text> : null}

      {data ? (
        <View style={styles.summary}>
          <View style={styles.card}>
            <Muted>{t.finance.youOweTotal}</Muted>
            <Text style={[styles.value, styles.negative]}>{data.youOwe.toFixed(2)} €</Text>
          </View>
          <View style={styles.card}>
            <Muted>{t.finance.youAreOwedTotal}</Muted>
            <Text style={[styles.value, styles.positive]}>{data.youAreOwed.toFixed(2)} €</Text>
          </View>
          <View style={styles.card}>
            <Muted>{t.finance.involved}</Muted>
            <Text style={styles.value}>{data.expensesInvolved}</Text>
          </View>
        </View>
      ) : null}

      <Subtitle>{t.finance.recent}</Subtitle>
      {!data?.series.length ? <EmptyState title={t.finance.noObligations} /> : null}
      {data?.series.map((e) => {
        const status =
          e.youOwe > 0.001
            ? t.finance.youOwe(e.youOwe)
            : e.youAreOwed > 0.001
              ? t.finance.youAreOwed(e.youAreOwed)
              : t.finance.yourBalanceSettled;
        const tone =
          e.youOwe > 0.001 ? styles.negative : e.youAreOwed > 0.001 ? styles.positive : undefined;
        return (
          <Pressable
            key={e.seriesId}
            style={styles.row}
            onPress={() =>
              router.push({
                pathname: '/activity/[id]',
                params: { id: e.activityId, tab: 'finance' },
              })
            }
            accessibilityRole="button"
            accessibilityLabel={`${e.title}. ${status}`}>
            <View style={{ flex: 1 }}>
              <Text style={styles.name}>{e.title}</Text>
              <Text style={[styles.status, tone]}>{status}</Text>
            </View>
            <FontAwesome name="angle-right" size={20} color={theme.colors.textMuted} />
          </Pressable>
        );
      })}

      <Text style={styles.back} onPress={() => router.back()}>
        {t.common.cancel}
      </Text>
      </ScrollView>
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
  positive: { color: theme.colors.success },
  negative: { color: theme.colors.danger },
  row: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.space.md,
    marginBottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  name: { fontWeight: '700', color: theme.colors.text },
  status: { marginTop: 4, fontSize: 13, color: theme.colors.textMuted, fontWeight: '600' },
  back: { marginTop: 16, color: theme.colors.primary, fontWeight: '700' },
  error: { color: theme.colors.danger, fontWeight: '600', marginBottom: 8 },
});
