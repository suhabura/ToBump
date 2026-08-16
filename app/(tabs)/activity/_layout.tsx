import { Stack } from 'expo-router';
import { theme } from '@/constants/theme';

export default function ActivityStackLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: theme.colors.surface },
        headerTintColor: theme.colors.text,
      }}>
      <Stack.Screen name="create" options={{ title: 'New event', presentation: 'modal' }} />
      <Stack.Screen name="[id]" options={{ title: 'Event' }} />
      <Stack.Screen name="edit/[id]" options={{ title: 'Edit event' }} />
    </Stack>
  );
}
