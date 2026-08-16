import FontAwesome from '@expo/vector-icons/FontAwesome';
import { Tabs, useRouter } from 'expo-router';
import { Pressable, View } from 'react-native';
import { theme } from '@/constants/theme';
import { useT } from '@/i18n';

function TabIcon({ name, color }: { name: React.ComponentProps<typeof FontAwesome>['name']; color: string }) {
  return <FontAwesome size={22} name={name} color={color} style={{ marginBottom: -2 }} />;
}

function HeaderActions() {
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
        <FontAwesome name="bell-o" size={20} color={theme.colors.text} />
      </Pressable>
    </View>
  );
}

export default function TabLayout() {
  const t = useT();

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: theme.colors.primary,
        tabBarInactiveTintColor: theme.colors.textMuted,
        tabBarStyle: { backgroundColor: theme.colors.surface, borderTopColor: theme.colors.border },
        headerStyle: { backgroundColor: theme.colors.surface },
        headerTintColor: theme.colors.text,
        headerRight: () => <HeaderActions />,
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
