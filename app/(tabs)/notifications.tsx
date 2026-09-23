import { format } from 'date-fns';
import { enUS, sl as slLocale } from 'date-fns/locale';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Button, EmptyState, Loading, Muted, Screen } from '@/components/ui';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';
import type { Notification } from '@/lib/types';
import { useLocale, useT } from '@/i18n';
import { theme } from '@/constants/theme';

export default function NotificationsScreen() {
  const t = useT();
  const router = useRouter();
  const { locale } = useLocale();
  const dfLocale = locale === 'sl' ? slLocale : enUS;
  const { user } = useAuth();
  const [items, setItems] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    const { data } = await supabase
      .from('notifications')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });
    setItems((data as Notification[]) ?? []);
    setLoading(false);
  }, [user]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  async function markRead(id: string) {
    await supabase.from('notifications').update({ is_read: true }).eq('id', id);
    load();
  }

  async function openItem(item: Notification) {
    await markRead(item.id);
    const data = item.data ?? {};
    const activityId = typeof data.activity_id === 'string' ? data.activity_id : null;
    if (item.type === 'friend_request' || item.type === 'friend_accepted') {
      router.push('/friends');
      return;
    }
    if (
      activityId &&
      (item.type === 'invite' ||
        item.type === 'message' ||
        item.type === 'activity_join' ||
        item.type === 'editor')
    ) {
      router.push(`/activity/${activityId}`);
    }
  }

  async function markAll() {
    if (!user) return;
    await supabase.from('notifications').update({ is_read: true }).eq('user_id', user.id).eq('is_read', false);
    load();
  }

  if (loading) return <Loading />;

  const unread = items.some((item) => !item.is_read);

  return (
    <Screen>
      {unread ? (
        <>
          <Button label={t.notifications.markAllRead} variant="secondary" onPress={markAll} />
          <View style={{ height: 12 }} />
        </>
      ) : null}
      <FlatList
        data={items}
        keyExtractor={(i) => i.id}
        ListEmptyComponent={<EmptyState title={t.notifications.empty} />}
        renderItem={({ item }) => (
          <Pressable style={styles.card} onPress={() => openItem(item)}>
            <View style={styles.row}>
              {!item.is_read ? <View style={styles.dot} /> : <View style={styles.dotSpacer} />}
              <View style={{ flex: 1 }}>
                <Text style={styles.msg}>{item.message}</Text>
                <Muted>{format(new Date(item.created_at), 'd MMM yyyy HH:mm', { locale: dfLocale })}</Muted>
              </View>
            </View>
          </Pressable>
        )}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.md,
    padding: theme.space.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    marginBottom: 8,
    ...theme.shadow.card,
  },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginTop: 6,
    backgroundColor: theme.colors.primary,
  },
  dotSpacer: { width: 8 },
  msg: { fontWeight: '600', color: theme.colors.text, marginBottom: 4 },
});
