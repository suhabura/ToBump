import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button, Chip, EmptyState, Input, Loading, Muted, Screen, Subtitle, Title } from '@/components/ui';
import { useAuth } from '@/contexts/AuthContext';
import {
  fetchShopProduct,
  formatShopPrice,
  requestShopOrder,
  type ShopProduct,
} from '@/lib/shop';
import { useT } from '@/i18n';
import { theme } from '@/constants/theme';

const SIZES = ['XS', 'S', 'M', 'L', 'XL'] as const;

export default function ShopProductScreen() {
  const t = useT();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const router = useRouter();
  const [product, setProduct] = useState<ShopProduct | null>(null);
  const [loading, setLoading] = useState(true);
  const [size, setSize] = useState<string>('M');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    (async () => {
      if (!id) return;
      setLoading(true);
      setProduct(await fetchShopProduct(id));
      setLoading(false);
    })();
  }, [id]);

  async function onOrder() {
    if (!user || !product) return;
    setSubmitting(true);
    const needsSize = product.category === 'apparel';
    const { error } = await requestShopOrder({
      userId: user.id,
      productId: product.id,
      quantity: 1,
      size: needsSize ? size : null,
      note: note.trim() || null,
    });
    setSubmitting(false);
    if (error) {
      if (product.id.startsWith('local-')) {
        Alert.alert(t.shop.title, t.shop.runSql);
      } else {
        Alert.alert(t.common.error, error);
      }
      return;
    }
    Alert.alert(t.shop.orderSentTitle, t.shop.orderSentBody, [
      { text: t.common.ok, onPress: () => router.back() },
    ]);
  }

  if (loading) return <Loading />;
  if (!product) {
    return (
      <Screen>
        <EmptyState title={t.shop.notFound} />
      </Screen>
    );
  }

  const needsSize = product.category === 'apparel';

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
        <View style={styles.hero}>
          <Text style={styles.heroLetter}>{product.name.charAt(0)}</Text>
        </View>
        <Title>{product.name}</Title>
        <Text style={styles.price}>{formatShopPrice(product.price, product.currency)}</Text>
        {product.description ? <Muted>{product.description}</Muted> : null}

        {needsSize ? (
          <View style={{ marginTop: 16 }}>
            <Subtitle>{t.shop.size}</Subtitle>
            <View style={styles.sizes}>
              {SIZES.map((s) => (
                <Chip key={s} label={s} active={size === s} onPress={() => setSize(s)} />
              ))}
            </View>
          </View>
        ) : null}

        <View style={{ marginTop: 12 }}>
          <Input
            label={t.shop.note}
            value={note}
            onChangeText={setNote}
            placeholder={t.shop.notePlaceholder}
          />
        </View>

        <Button label={t.shop.requestOrder} onPress={onOrder} loading={submitting} />
        <Muted>{t.shop.checkoutHint}</Muted>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: {
    height: 160,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  heroLetter: {
    fontSize: 64,
    fontWeight: '800',
    color: theme.colors.primary,
  },
  price: {
    fontSize: 22,
    fontWeight: '700',
    color: theme.colors.primaryDark,
    marginVertical: 8,
  },
  sizes: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8, marginBottom: 8 },
});
