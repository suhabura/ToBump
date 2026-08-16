import { Stack } from 'expo-router';
import { theme } from '@/constants/theme';

export default function EnterpriseStackLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: theme.colors.surface },
        headerTintColor: theme.colors.text,
      }}>
      <Stack.Screen name="create" options={{ title: 'Venue', presentation: 'modal' }} />
      <Stack.Screen name="[id]" options={{ title: 'Venue' }} />
    </Stack>
  );
}
