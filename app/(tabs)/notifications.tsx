import { format } from 'date-fns';
import { enUS } from 'date-fns/locale';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Button, EmptyState, Loading, Muted, Screen } from '@/components/ui';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';
import type { Notification } from '@/lib/types';
import { useT } from '@/i18n';
import { theme } from '@/constants/theme';

export default function NotificationsScreen() {
  const t = useT();
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

  async function markAll() {
    if (!user) return;
    await supabase.from('notifications').update({ is_read: true }).eq('user_id', user.id).eq('is_read', false);
    load();
  }

  if (loading) return <Loading />;

  return (
    <Screen>
      <Button label={t.notifications.markAllRead} variant="secondary" onPress={markAll} />
      <View style={{ height: 12 }} />
      <FlatList
        data={items}
        keyExtractor={(i) => i.id}
        ListEmptyComponent={<EmptyState title={t.notifications.empty} />}
        renderItem={({ item }) => (
          <Pressable
            style={[styles.card, !item.is_read && styles.unread]}
            onPress={() => markRead(item.id)}>
            <Text style={styles.msg}>{item.message}</Text>
            <Muted>{format(new Date(item.created_at), 'd MMM yyyy HH:mm', { locale: enUS })}</Muted>
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
  },
  unread: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.primarySoft,
  },
  msg: { fontWeight: '600', color: theme.colors.text, marginBottom: 4 },
});
