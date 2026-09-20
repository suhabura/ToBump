import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Tabs, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Image, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { theme } from '@/constants/theme';
import { useAuth } from '@/contexts/AuthContext';
import { useT } from '@/i18n';
import { supabase } from '@/lib/supabase';

function TabIcon({ name, color }: { name: React.ComponentProps<typeof FontAwesome>['name']; color: string }) {
  return <FontAwesome size={22} name={name} color={color} style={{ marginBottom: -2 }} />;
}

const webPad = (edge: 'top' | 'bottom') =>
  `env(safe-area-inset-${edge}, 0px)` as unknown as number;

function TabAppHeader({ title, unread }: { title: string; unread: number }) {
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        styles.headerSafe,
        { paddingTop: Platform.OS === 'web' ? webPad('top') : insets.top },
      ]}>
      <View style={styles.headerBar} accessibilityRole="header">
        <Text style={styles.brandTab} numberOfLines={1}>
          {title}
        </Text>
        <Image
          source={require('../../assets/brand/logo-horizontal.png')}
          style={styles.brandLogo}
          resizeMode="contain"
          accessibilityLabel={t.appName}
        />
        <Pressable
          onPress={() => router.push('/notifications')}
          style={styles.bellHit}
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
    </View>
  );
}

function HeaderActions({ unread }: { unread: number }) {
  const router = useRouter();
  return (
    <View style={styles.headerSide}>
      <Pressable
        onPress={() => router.push('/notifications')}
        style={styles.bellHitModal}
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
  const insets = useSafeAreaInsets();
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
      safeAreaInsets={{ top: 0, bottom: 0 }}
      screenOptions={{
        headerStatusBarHeight: 0,
        tabBarActiveTintColor: theme.colors.primary,
        tabBarInactiveTintColor: theme.colors.textMuted,
        tabBarStyle: {
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.border,
          paddingTop: 4,
          ...(Platform.OS === 'web'
            ? {
                height: 'calc(52px + env(safe-area-inset-bottom, 0px))' as unknown as number,
                paddingBottom: webPad('bottom'),
              }
            : {
                height: 52 + insets.bottom,
                paddingBottom: insets.bottom,
              }),
        },
        headerStyle: { backgroundColor: theme.colors.surface },
        headerTintColor: theme.colors.text,
        headerRight: () => <HeaderActions unread={unread} />,
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: t.tabs.events,
          header: () => <TabAppHeader title={t.tabs.events} unread={unread} />,
          tabBarIcon: ({ color }) => <TabIcon name="list-alt" color={String(color)} />,
        }}
      />
      <Tabs.Screen
        name="planner"
        options={{
          title: t.tabs.planner,
          header: () => <TabAppHeader title={t.tabs.planner} unread={unread} />,
          tabBarIcon: ({ color }) => <TabIcon name="calendar" color={String(color)} />,
        }}
      />
      <Tabs.Screen
        name="friends"
        options={{
          title: t.tabs.friends,
          header: () => <TabAppHeader title={t.tabs.friends} unread={unread} />,
          tabBarBadge: pendingFriends > 0 ? pendingFriends : undefined,
          tabBarIcon: ({ color }) => <TabIcon name="users" color={String(color)} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: t.tabs.profile,
          header: () => <TabAppHeader title={t.tabs.profile} unread={unread} />,
          tabBarIcon: ({ color }) => <TabIcon name="user" color={String(color)} />,
        }}
      />

      <Tabs.Screen name="activity" options={{ href: null, headerShown: false }} />
      <Tabs.Screen name="chat" options={{ href: null, headerShown: false }} />
      <Tabs.Screen name="enterprise" options={{ href: null, headerShown: false }} />
      <Tabs.Screen name="shop" options={{ href: null, headerShown: false }} />
      <Tabs.Screen
        name="groups"
        options={{ href: null, title: 'Groups', headerTitle: 'Groups', presentation: 'modal' }}
      />
      <Tabs.Screen
        name="payments"
        options={{
          href: null,
          title: t.finance.myPayments,
          headerTitle: t.finance.myPayments,
          presentation: 'modal',
        }}
      />
      <Tabs.Screen
        name="notifications"
        options={{
          href: null,
          title: t.notifications.title,
          headerTitle: t.notifications.title,
          presentation: 'modal',
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  headerSafe: {
    backgroundColor: theme.colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  headerBar: {
    height: 76,
    justifyContent: 'center',
    alignItems: 'center',
  },
  brandLogo: {
    height: 68,
    width: 224,
  },
  brandTab: {
    position: 'absolute',
    left: 16,
    maxWidth: '28%',
    fontSize: 16,
    fontWeight: '700',
    color: theme.colors.text,
    letterSpacing: -0.2,
  },
  headerSide: {
    width: 48,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bellHit: {
    position: 'absolute',
    right: 8,
    padding: 8,
  },
  bellHitModal: {
    padding: 8,
  },
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
