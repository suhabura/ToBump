import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { Linking, StyleSheet, Text } from 'react-native';
import { EmptyState, Loading, Muted, Screen, Title } from '@/components/ui';
import { supabase } from '@/lib/supabase';
import type { Enterprise } from '@/lib/types';
import { useT } from '@/i18n';
import { theme } from '@/constants/theme';

export default function EnterpriseDetailScreen() {
  const t = useT();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [item, setItem] = useState<Enterprise | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from('enterprises').select('*').eq('id', id).maybeSingle();
      setItem((data as Enterprise) ?? null);
      setLoading(false);
    })();
  }, [id]);

  if (loading) return <Loading />;
  if (!item) {
    return (
      <Screen>
        <EmptyState title={t.venue.notFound} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Title>{item.name}</Title>
      <Muted>
        {item.provider_kind === 'tobump_booking' ? t.venue.tobumpSystem : t.venue.officialVenue}
      </Muted>
      {item.address ? <Muted>{item.address}</Muted> : null}
      {item.latitude != null && item.longitude != null ? (
        <Text
          style={styles.link}
          onPress={() =>
            Linking.openURL(`https://www.google.com/maps?q=${item.latitude},${item.longitude}`)
          }>
          {t.venue.openGoogleMaps} ({item.latitude.toFixed(5)}, {item.longitude.toFixed(5)})
        </Text>
      ) : null}
      {item.phone ? <Muted>{t.common.phone}: {item.phone}</Muted> : null}
      {item.email ? <Muted>{item.email}</Muted> : null}
      {item.price != null ? <Muted>{t.common.price}: {item.price} €</Muted> : null}
      {item.website ? (
        <Text style={styles.link} onPress={() => Linking.openURL(item.website!)}>
          {item.website}
        </Text>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  link: { color: theme.colors.primary, marginTop: 12, fontWeight: '600' },
});
