import { Link } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button, Input, Muted, Title } from '@/components/ui';
import { useAuth } from '@/contexts/AuthContext';
import { useT } from '@/i18n';
import { theme } from '@/constants/theme';

export default function LoginScreen() {
  const t = useT();
  const { signIn, configured } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit() {
    setError(null);
    if (!configured) {
      setError(t.common.configureSupabase);
      return;
    }
    if (!email.trim() || !password) {
      setError('Enter email and password.');
      return;
    }
    setLoading(true);
    const { error: err } = await signIn(email, password);
    setLoading(false);
    if (err) {
      const tip =
        err.toLowerCase().includes('invalid') || err.toLowerCase().includes('credentials')
          ? 'Wrong email or password. If you don’t have an account yet, tap Sign up below.'
          : err.toLowerCase().includes('confirm') || err.toLowerCase().includes('verified')
            ? 'Email not confirmed yet. In Supabase → Authentication → Providers → Email turn off “Confirm email”, or confirm the message.'
            : err;
      setError(tip);
    }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.wrap} keyboardShouldPersistTaps="handled">
        <View style={styles.hero}>
          <Text style={styles.brand}>{t.appName}</Text>
          <Muted>{t.tagline}</Muted>
        </View>

        {!configured ? (
          <View style={styles.warn}>
            <Muted>{t.common.configureSupabase}</Muted>
          </View>
        ) : null}

        <Title>{t.auth.login}</Title>
        {error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}
        <Input
          label={t.auth.email}
          autoCapitalize="none"
          keyboardType="email-address"
          value={email}
          onChangeText={setEmail}
        />
        <Input
          label={t.auth.password}
          secureTextEntry
          value={password}
          onChangeText={setPassword}
        />
        <Button label={t.auth.login} onPress={onSubmit} loading={loading} />
        <Link href="/(auth)/forgot" style={styles.link}>
          {t.auth.forgot}
        </Link>
        <Link href="/(auth)/register" style={styles.link}>
          {t.auth.noAccount} {t.auth.register}
        </Link>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: theme.space.lg,
    backgroundColor: theme.colors.background,
  },
  hero: {
    marginBottom: theme.space.xl,
  },
  brand: {
    fontSize: 40,
    fontWeight: '800',
    color: theme.colors.primary,
    letterSpacing: -0.5,
  },
  link: {
    marginTop: theme.space.md,
    color: theme.colors.primary,
    fontWeight: '600',
    textAlign: 'center',
  },
  warn: {
    backgroundColor: '#FEF3C7',
    padding: theme.space.md,
    borderRadius: theme.radius.md,
    marginBottom: theme.space.md,
  },
  errorBox: {
    backgroundColor: '#FEE2E2',
    padding: theme.space.md,
    borderRadius: theme.radius.md,
    marginBottom: theme.space.md,
  },
  errorText: {
    color: theme.colors.danger,
    fontWeight: '600',
  },
});
