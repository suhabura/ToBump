import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Tabs, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { theme } from '@/constants/theme';
import { useAuth } from '@/contexts/AuthContext';
import { useT } from '@/i18n';
import { supabase } from '@/lib/supabase';

function TabIcon({ name, color }: { name: React.ComponentProps<typeof FontAwesome>['name']; color: string }) {
  return <FontAwesome size={22} name={name} color={color} style={{ marginBottom: -2 }} />;
}

function HeaderActions({ unread }: { unread: number }) {
  const router = useRouter();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', marginRight: 12, gap: 4 }}>
      <Pressable
        onPress={() => router.push('/shop')}
        style={{ paddingHorizontal: 10, paddingVertical: 6 }}
        accessibilityRole="button"
        accessibilityLabel="Shop">
        <FontAwesome name="shopping-bag" size={20} color={theme.colors.text} />
      </Pressable>
      <Pressable
        onPress={() => router.push('/notifications')}
        style={{ paddingHorizontal: 10, paddingVertical: 6 }}
        accessibilityRole="button"
        accessibilityLabel="Notifications">
        <View>
          <FontAwesome name={unread > 0 ? 'bell' : 'bell-o'} size={20} color={theme.colors.text} />
          {unread > 0 ? (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{unread > 99 ? '99+' : String(unread)}</Text>
            </View>
          ) : null}
        </View>
      </Pressable>
    </View>
  );
}

export default function TabLayout() {
  const t = useT();
  const { user } = useAuth();
  const [unread, setUnread] = useState(0);
  const [pendingFriends, setPendingFriends] = useState(0);

  useEffect(() => {
    if (!user) {
      setUnread(0);
      setPendingFriends(0);
      return;
    }

    let cancelled = false;

    async function refresh() {
      const [{ count: notifCount }, { count: friendCount }] = await Promise.all([
        supabase
          .from('notifications')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', user!.id)
          .eq('is_read', false),
        supabase
          .from('friendships')
          .select('*', { count: 'exact', head: true })
          .eq('to_user_id', user!.id)
          .eq('status', 'pending'),
      ]);
      if (cancelled) return;
      setUnread(notifCount ?? 0);
      setPendingFriends(friendCount ?? 0);
    }

    refresh();

    const notifChannel = supabase
      .channel(`notif-badge-${user.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'notifications', filter: `user_id=eq.${user.id}` },
        () => {
          refresh();
        }
      )
      .subscribe();

    const friendChannel = supabase
      .channel(`friend-badge-${user.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'friendships', filter: `to_user_id=eq.${user.id}` },
        () => {
          refresh();
        }
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(notifChannel);
      supabase.removeChannel(friendChannel);
    };
  }, [user]);

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: theme.colors.primary,
        tabBarInactiveTintColor: theme.colors.textMuted,
        tabBarStyle: { backgroundColor: theme.colors.surface, borderTopColor: theme.colors.border },
        headerStyle: { backgroundColor: theme.colors.surface },
        headerTintColor: theme.colors.text,
        headerRight: () => <HeaderActions unread={unread} />,
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: t.tabs.events,
          tabBarIcon: ({ color }) => <TabIcon name="calendar" color={String(color)} />,
        }}
      />
      <Tabs.Screen
        name="planner"
        options={{
          title: t.tabs.planner,
          tabBarIcon: ({ color }) => <TabIcon name="list-alt" color={String(color)} />,
        }}
      />
      <Tabs.Screen
        name="friends"
        options={{
          title: t.tabs.friends,
          tabBarBadge: pendingFriends > 0 ? pendingFriends : undefined,
          tabBarIcon: ({ color }) => <TabIcon name="users" color={String(color)} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: t.tabs.profile,
          tabBarIcon: ({ color }) => <TabIcon name="user" color={String(color)} />,
        }}
      />

      <Tabs.Screen name="activity" options={{ href: null, headerShown: false }} />
      <Tabs.Screen name="chat" options={{ href: null, headerShown: false }} />
      <Tabs.Screen name="enterprise" options={{ href: null, headerShown: false }} />
      <Tabs.Screen name="shop" options={{ href: null, headerShown: false }} />
      <Tabs.Screen name="groups" options={{ href: null, title: 'Groups', presentation: 'modal' }} />
      <Tabs.Screen
        name="notifications"
        options={{ href: null, title: t.notifications.title, presentation: 'modal' }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  badge: {
    position: 'absolute',
    top: -4,
    right: -8,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: theme.colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  badgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
  },
});
