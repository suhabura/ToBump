import { Stack } from 'expo-router';
import { useT } from '@/i18n';
import { theme } from '@/constants/theme';

export default function ShopLayout() {
  const t = useT();
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: theme.colors.surface },
        headerTintColor: theme.colors.text,
        contentStyle: { backgroundColor: theme.colors.background },
      }}>
      <Stack.Screen name="index" options={{ title: t.shop.title }} />
      <Stack.Screen name="[id]" options={{ title: t.shop.product }} />
    </Stack>
  );
}
