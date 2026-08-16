import { Stack } from 'expo-router';
import { theme } from '@/constants/theme';

export default function ChatStackLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: theme.colors.surface },
        headerTintColor: theme.colors.text,
      }}>
      <Stack.Screen name="[activityId]" options={{ title: 'Chat' }} />
    </Stack>
  );
}
