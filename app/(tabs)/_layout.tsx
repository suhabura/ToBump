import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Tabs, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Image, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { theme } from '@/constants/theme';
import { useAuth } from '@/contexts/AuthContext';
import { EventsHeaderProvider, useEventsHeader } from '@/contexts/EventsHeaderContext';
import { useT } from '@/i18n';
import { supabase } from '@/lib/supabase';

function TabIcon({ name, color }: { name: React.ComponentProps<typeof FontAwesome>['name']; color: string }) {
  return <FontAwesome size={22} name={name} color={color} style={{ marginBottom: -2 }} />;
}

function HeaderIcon({
  name,
  color,
  onPress,
  accessibilityLabel,
  badge,
}: {
  name: React.ComponentProps<typeof FontAwesome>['name'];
  color?: string;
  onPress: () => void;
  accessibilityLabel: string;
  badge?: number;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={styles.headerIcon}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}>
      <View>
        <FontAwesome name={name} size={20} color={color ?? theme.colors.text} />
        {badge && badge > 0 ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{badge > 99 ? '99+' : String(badge)}</Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

function TabAppHeader({
  title,
  unread,
  events,
}: {
  title: string;
  unread: number;
  events?: boolean;
}) {
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { controls } = useEventsHeader();
  const extras = events ? controls : null;

  return (
    <View
      style={[
        styles.headerSafe,
        { paddingTop: Platform.OS === 'web' ? 0 : insets.top },
      ]}>
      {extras?.searchOpen ? (
        <View style={styles.searchBar} accessibilityRole="header">
          <HeaderIcon
            name="angle-left"
            onPress={extras.onSearchClose}
            accessibilityLabel={t.common.cancel}
          />
          <TextInput
            style={styles.searchInput}
            placeholder={t.events.search}
            placeholderTextColor={theme.colors.textMuted}
            value={extras.search}
            onChangeText={extras.onSearchChange}
            onSubmitEditing={extras.onSearchSubmit}
            autoFocus
            returnKeyType="search"
            autoCapitalize="none"
            autoCorrect={false}
          />
          {extras.search ? (
            <HeaderIcon
              name="times"
              onPress={() => extras.onSearchChange('')}
              accessibilityLabel={t.common.clear}
            />
          ) : null}
        </View>
      ) : (
        <View style={styles.headerBar} accessibilityRole="header">
          <View style={styles.headerSlot}>
            <Text style={styles.brandTab} numberOfLines={1}>
              {title}
            </Text>
          </View>
          <View style={styles.logoWrap} pointerEvents="none">
            <Image
              source={require('../../assets/brand/logo-horizontal.png')}
              style={styles.brandLogo}
              resizeMode="contain"
              accessibilityLabel={t.appName}
            />
          </View>
          <View style={[styles.headerSlot, styles.headerSlotRight]}>
            {events ? (
              <HeaderIcon
                name="search"
                onPress={() => extras?.onSearchOpen()}
                accessibilityLabel={t.events.search}
              />
            ) : null}
            <HeaderIcon
              name={unread > 0 ? 'bell' : 'bell-o'}
              onPress={() => router.push('/notifications')}
              accessibilityLabel="Notifications"
              badge={unread}
            />
          </View>
        </View>
      )}
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
    <EventsHeaderProvider>
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
              ? { height: 52, paddingBottom: 0 }
              : { height: 52 + insets.bottom, paddingBottom: insets.bottom }),
          },
          headerStyle: { backgroundColor: theme.colors.surface },
          headerTintColor: theme.colors.text,
          headerRight: () => <HeaderActions unread={unread} />,
        }}>
        <Tabs.Screen
          name="index"
          options={{
            title: t.tabs.events,
            header: () => <TabAppHeader title={t.tabs.events} unread={unread} events />,
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
    </EventsHeaderProvider>
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
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 4,
  },
  headerSlot: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    zIndex: 1,
    minWidth: 0,
  },
  headerSlotRight: {
    justifyContent: 'flex-end',
  },
  headerIcon: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchBar: {
    height: 76,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 4,
    gap: 4,
  },
  searchInput: {
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    height: 40,
    paddingHorizontal: 12,
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surfaceElevated,
    fontSize: 16,
    color: theme.colors.text,
  },
  logoWrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandLogo: {
    height: 68,
    width: 224,
  },
  brandTab: {
    marginLeft: 12,
    maxWidth: '100%',
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
