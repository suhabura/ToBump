import { Redirect, Stack, useSegments } from 'expo-router';
import { DefaultTheme, ThemeProvider } from 'expo-router/react-navigation';
import * as SplashScreen from 'expo-splash-screen';
import { useCallback, useEffect } from 'react';
import 'react-native-reanimated';

import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import { LocaleProvider, type Locale } from '@/i18n';
import { theme } from '@/constants/theme';
import { Loading } from '@/components/ui';

export { ErrorBoundary } from 'expo-router';

SplashScreen.preventAutoHideAsync();

const NavLight = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    primary: theme.colors.primary,
    background: theme.colors.background,
    card: theme.colors.surface,
    text: theme.colors.text,
    border: theme.colors.border,
  },
};

function AuthGate({ children }: { children: React.ReactNode }) {
  const { session, loading } = useAuth();
  const segments = useSegments();
  const inAuth = segments[0] === '(auth)';

  useEffect(() => {
    SplashScreen.hideAsync();
  }, []);

  if (loading) return <Loading />;

  if (!session && !inAuth) {
    return <Redirect href="/(auth)/login" />;
  }

  if (session && inAuth) {
    return <Redirect href="/(tabs)" />;
  }

  return <>{children}</>;
}

function AppI18n({ children }: { children: React.ReactNode }) {
  const { session, settings, updateSettings } = useAuth();
  const persist = useCallback(
    async (locale: Locale) => {
      if (!session?.user) return;
      await updateSettings({ locale });
    },
    [session?.user, updateSettings]
  );

  return (
    <LocaleProvider settingsLocale={settings?.locale} onPersistLocale={persist}>
      {children}
    </LocaleProvider>
  );
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <AppI18n>
        <ThemeProvider value={NavLight}>
          <AuthGate>
            <Stack>
              <Stack.Screen name="(auth)" options={{ headerShown: false }} />
              <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
              <Stack.Screen name="+not-found" />
            </Stack>
          </AuthGate>
        </ThemeProvider>
      </AppI18n>
    </AuthProvider>
  );
}
