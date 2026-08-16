import { format } from 'date-fns';
import { enUS } from 'date-fns/locale';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Button, Chip, EmptyState, Input, Loading, Muted, Screen, Subtitle } from '@/components/ui';
import { useAuth } from '@/contexts/AuthContext';
import { ensureDefaultCategories, fetchActivities, fetchMainCategories } from '@/lib/api';
import { formatDistance } from '@/lib/geo';
import type { ActivityWithRelations, Category } from '@/lib/types';
import { activityLocationLabel, categoryLabel, displayName } from '@/lib/types';
import { useT, categoryDisplayName } from '@/i18n';
import { theme } from '@/constants/theme';

type Filter = 'invited' | 'mine' | 'commercial';

const RADIUS_OPTIONS_KM = [10, 30, 50, 100] as const;

export default function EventsScreen() {
  const t = useT();
  const { user, profile, configured } = useAuth();
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>('invited');
  const [commercialRadiusKm, setCommercialRadiusKm] = useState(30);
  const [commercialCategoryId, setCommercialCategoryId] = useState<string | null>(null);
  const [commercialMaxPrice, setCommercialMaxPrice] = useState<number | null>(null);
  const [draftRadiusKm, setDraftRadiusKm] = useState(30);
  const [draftCategoryId, setDraftCategoryId] = useState<string | null>(null);
  const [draftMaxPrice, setDraftMaxPrice] = useState<number | null>(null);
  const [showCommercialFilters, setShowCommercialFilters] = useState(false);
  const [categories, setCategories] = useState<Category[]>([]);
  const [search, setSearch] = useState('');

  const PRICE_OPTIONS: { key: string; maxPrice: number | null; label: string }[] = [
    { key: 'any', maxPrice: null, label: t.events.priceAny },
    { key: 'free', maxPrice: 0, label: t.events.priceFree },
    { key: '10', maxPrice: 10, label: t.events.priceUpTo(10) },
    { key: '25', maxPrice: 25, label: t.events.priceUpTo(25) },
    { key: '50', maxPrice: 50, label: t.events.priceUpTo(50) },
    { key: '100', maxPrice: 100, label: t.events.priceUpTo(100) },
  ];
  const [items, setItems] = useState<ActivityWithRelations[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const userId = user?.id;
  const profileLat = profile?.latitude ?? null;
  const profileLng = profile?.longitude ?? null;
  const origin =
    profileLat != null && profileLng != null
      ? { latitude: profileLat, longitude: profileLng }
      : null;

  function openCommercialFilters() {
    setDraftRadiusKm(commercialRadiusKm);
    setDraftCategoryId(commercialCategoryId);
    setDraftMaxPrice(commercialMaxPrice);
    setShowCommercialFilters(true);
  }

  function cancelCommercialFilters() {
    setDraftRadiusKm(commercialRadiusKm);
    setDraftCategoryId(commercialCategoryId);
    setDraftMaxPrice(commercialMaxPrice);
    setShowCommercialFilters(false);
  }

  function applyCommercialFilters() {
    setCommercialRadiusKm(draftRadiusKm);
    setCommercialCategoryId(draftCategoryId);
    setCommercialMaxPrice(draftMaxPrice);
    setShowCommercialFilters(false);
  }

  function resetCommercialFilters() {
    setCommercialRadiusKm(30);
    setCommercialCategoryId(null);
    setCommercialMaxPrice(null);
    setDraftRadiusKm(30);
    setDraftCategoryId(null);
    setDraftMaxPrice(null);
    setShowCommercialFilters(false);
  }

  useEffect(() => {
    if (filter !== 'commercial') return;
    (async () => {
      await ensureDefaultCategories();
      setCategories(await fetchMainCategories());
    })();
  }, [filter]);

  const load = useCallback(async () => {
    if (!userId || !configured) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const loc =
        profileLat != null && profileLng != null
          ? { latitude: profileLat, longitude: profileLng }
          : null;
      const data = await fetchActivities({
        userId,
        filter,
        search,
        radiusKm: filter === 'commercial' ? commercialRadiusKm : undefined,
        origin: filter === 'commercial' ? loc : null,
        categoryId: filter === 'commercial' ? commercialCategoryId : undefined,
        maxPrice: filter === 'commercial' ? commercialMaxPrice : undefined,
      });
      setItems(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : t.common.error);
    } finally {
      setLoading(false);
    }
  }, [
    userId,
    configured,
    filter,
    search,
    commercialRadiusKm,
    commercialCategoryId,
    commercialMaxPrice,
    profileLat,
    profileLng,
  ]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load])
  );

  if (!configured) {
    return (
      <Screen>
        <EmptyState title="Supabase not configured" subtitle={t.common.configureSupabase} />
      </Screen>
    );
  }

  return (
    <Screen style={{ paddingBottom: 0 }}>
      <View style={styles.row}>
        <View style={{ flex: 1 }}>
          <Input
            placeholder={t.events.search}
            value={search}
            onChangeText={setSearch}
            onSubmitEditing={load}
            style={{ marginBottom: 0 }}
          />
        </View>
      </View>
      <View style={styles.filters}>
        <Chip
          label={t.events.invited}
          active={filter === 'invited'}
          onPress={() => {
            setFilter('invited');
            resetCommercialFilters();
          }}
        />
        <Chip
          label={t.events.mine}
          active={filter === 'mine'}
          onPress={() => {
            setFilter('mine');
            resetCommercialFilters();
          }}
        />
        <Chip
          label={t.events.commercial}
          active={filter === 'commercial'}
          onPress={() => setFilter('commercial')}
        />
      </View>

      {filter === 'commercial' ? (
        <View style={styles.commercialFilters}>
          {!showCommercialFilters ? (
            <Button label={t.events.filterButton} variant="secondary" onPress={openCommercialFilters} />
          ) : (
            <View style={{ gap: 6 }}>
              <Muted>{t.events.commercialCategory}</Muted>
              <View style={styles.radiusRow}>
                <Chip
                  label={t.events.filterAll}
                  active={draftCategoryId == null}
                  onPress={() => setDraftCategoryId(null)}
                />
                {categories.map((c) => (
                  <Chip
                    key={c.id}
                    label={categoryDisplayName(c.name)}
                    active={draftCategoryId === c.id}
                    onPress={() => setDraftCategoryId(c.id)}
                  />
                ))}
              </View>

              <Muted>{t.events.commercialPrice}</Muted>
              <View style={styles.radiusRow}>
                {PRICE_OPTIONS.map((p) => (
                  <Chip
                    key={p.key}
                    label={p.label}
                    active={draftMaxPrice === p.maxPrice}
                    onPress={() => setDraftMaxPrice(p.maxPrice)}
                  />
                ))}
              </View>

              <Muted>{t.events.commercialRadius}</Muted>
              {!origin ? (
                <Muted>{t.events.needLocationForRadius}</Muted>
              ) : (
                <View style={styles.radiusRow}>
                  {RADIUS_OPTIONS_KM.map((km) => (
                    <Chip
                      key={km}
                      label={`${km} km`}
                      active={draftRadiusKm === km}
                      onPress={() => setDraftRadiusKm(km)}
                    />
                  ))}
                </View>
              )}

              <View style={styles.filterActions}>
                <Button label={t.common.cancel} variant="ghost" onPress={cancelCommercialFilters} />
                <Button label={t.events.applyFilters} onPress={applyCommercialFilters} />
              </View>
            </View>
          )}
        </View>
      ) : (
        <Button label={t.events.create} onPress={() => router.push('/activity/create')} />
      )}
      <View style={{ height: 12 }} />

      {loading ? (
        <Loading />
      ) : error ? (
        <EmptyState title={error} subtitle={t.common.retry} />
      ) : filter === 'commercial' && !origin ? (
        <EmptyState title={t.events.needLocationForRadius} />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ paddingBottom: 32 }}
          ListEmptyComponent={<EmptyState title={t.events.empty} />}
          renderItem={({ item }) => {
            const location = activityLocationLabel(item);
            const priceNum = Number(item.price ?? 0);
            const cat = categoryLabel(item.categories) ?? `${item.title} (${t.events.uncategorized})`;
            return (
              <Pressable style={styles.card} onPress={() => router.push(`/activity/${item.id}`)}>
                <Subtitle>{cat}</Subtitle>
                <Muted>
                  {format(new Date(item.starts_at), 'EEE, d MMM yyyy · HH:mm', { locale: enUS })}
                </Muted>
                {location ? (
                  <Muted>
                    {t.events.location}: {location}
                    {item.distance_m != null ? ` · ${formatDistance(item.distance_m)}` : ''}
                  </Muted>
                ) : null}
                <Muted>
                  {t.events.price}: {priceNum > 0 ? `${priceNum} €` : t.common.free}
                  {` · ${displayName(item.profiles)}`}
                </Muted>
                <View style={styles.meta}>
                  {item.is_invited ? (
                    <Text style={[styles.badge, styles.invited]}>{t.events.invited}</Text>
                  ) : null}
                  {item.created_by === user?.id && !item.is_invited ? (
                    <Text style={[styles.badge, styles.mine]}>{t.events.mine}</Text>
                  ) : null}
                  {item.is_commercial && item.created_by !== user?.id && !item.is_invited ? (
                    <Text style={[styles.badge, styles.commercial]}>{t.events.commercial}</Text>
                  ) : null}
                  {item.is_from_friend && !item.is_invited && item.created_by !== user?.id ? (
                    <Text style={[styles.badge, styles.friend]}>{t.events.friend}</Text>
                  ) : null}
                  <Text style={styles.badge}>
                    {item.join_count ?? 0}
                    {item.max_participants ? `/${item.max_participants}` : ''}{' '}
                    {t.events.participants.toLowerCase()}
                  </Text>
                  {item.is_joined ? (
                    <Text style={[styles.badge, styles.joined]}>{t.events.joined}</Text>
                  ) : null}
                </View>
              </Pressable>
            );
          }}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { marginBottom: theme.space.sm },
  filters: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: theme.space.sm, gap: 6 },
  commercialFilters: { marginBottom: theme.space.md, gap: 6 },
  radiusRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 8 },
  filterActions: { flexDirection: 'row', gap: 8, marginTop: 8 },
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    padding: theme.space.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    marginBottom: theme.space.sm,
  },
  meta: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  badge: {
    backgroundColor: theme.colors.primarySoft,
    color: theme.colors.primaryDark,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    overflow: 'hidden',
    fontSize: 12,
    fontWeight: '600',
  },
  joined: { backgroundColor: '#DCFCE7', color: theme.colors.success },
  invited: { backgroundColor: '#FEF3C7', color: '#92400E' },
  mine: { backgroundColor: '#E0E7FF', color: '#3730A3' },
  commercial: { backgroundColor: '#FFEDD5', color: '#9A3412' },
  friend: { backgroundColor: '#DBEAFE', color: '#1E40AF' },
});
