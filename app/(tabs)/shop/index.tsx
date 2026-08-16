import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { EmptyState, Loading, Muted, Screen, Subtitle, Title } from '@/components/ui';
import { fetchShopProducts, formatShopPrice, type ShopProduct } from '@/lib/shop';
import { useT } from '@/i18n';
import { theme } from '@/constants/theme';

export default function ShopScreen() {
  const t = useT();
  const router = useRouter();
  const [items, setItems] = useState<ShopProduct[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setItems(await fetchShopProducts());
    setLoading(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  if (loading) return <Loading />;

  return (
    <Screen>
      <Title>{t.shop.title}</Title>
      <Muted>{t.shop.subtitle}</Muted>
      <View style={{ height: 16 }} />
      <FlatList
        data={items}
        keyExtractor={(i) => i.id}
        contentContainerStyle={{ paddingBottom: 40 }}
        ListEmptyComponent={<EmptyState title={t.shop.empty} />}
        renderItem={({ item }) => (
          <Pressable style={styles.card} onPress={() => router.push(`/shop/${item.id}`)}>
            <View style={styles.thumb}>
              <Text style={styles.thumbLetter}>{item.name.charAt(0)}</Text>
            </View>
            <View style={styles.body}>
              <Subtitle>{item.name}</Subtitle>
                  {item.description ? (
                <Text style={styles.desc} numberOfLines={2}>
                  {item.description}
                </Text>
              ) : null}
              <Text style={styles.price}>{formatShopPrice(item.price, item.currency)}</Text>
            </View>
          </Pressable>
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    gap: 14,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: 14,
    marginBottom: 10,
  },
  thumb: {
    width: 64,
    height: 64,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbLetter: {
    fontSize: 24,
    fontWeight: '700',
    color: theme.colors.primary,
  },
  body: { flex: 1, gap: 4 },
  desc: { fontSize: 13, color: theme.colors.textMuted, lineHeight: 18 },
  price: {
    marginTop: 4,
    fontSize: 16,
    fontWeight: '700',
    color: theme.colors.primaryDark,
  },
});
