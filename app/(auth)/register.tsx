import { Link, useRouter } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button, Input, Title } from '@/components/ui';
import { useAuth } from '@/contexts/AuthContext';
import { useT } from '@/i18n';
import { theme } from '@/constants/theme';

export default function RegisterScreen() {
  const t = useT();
  const { signUp } = useAuth();
  const router = useRouter();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function onSubmit() {
    setError(null);
    setInfo(null);
    if (!firstName.trim() || !email.trim() || password.length < 6) {
      setError('Fill in first name, email, and password (min. 6 characters).');
      return;
    }
    setLoading(true);
    const { error: err } = await signUp(email, password, firstName, lastName);
    setLoading(false);
    if (err) {
      setError(err);
      return;
    }
    setInfo('Account created. If email confirmation is required, check your inbox — or turn off Confirm email in Supabase. Then log in.');
    setTimeout(() => router.replace('/(auth)/login'), 1500);
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={styles.wrap} keyboardShouldPersistTaps="handled">
        <Title>{t.auth.register}</Title>
        {error ? (
          <View style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}
        {info ? (
          <View style={styles.infoBox}>
            <Text style={styles.infoText}>{info}</Text>
          </View>
        ) : null}
        <Input label={t.auth.firstName} value={firstName} onChangeText={setFirstName} />
        <Input label={t.auth.lastName} value={lastName} onChangeText={setLastName} />
        <Input
          label={t.auth.email}
          autoCapitalize="none"
          keyboardType="email-address"
          value={email}
          onChangeText={setEmail}
        />
        <Input label={t.auth.password} secureTextEntry value={password} onChangeText={setPassword} />
        <Button label={t.auth.register} onPress={onSubmit} loading={loading} />
        <Link href="/(auth)/login" style={styles.link}>
          {t.auth.hasAccount} {t.auth.login}
        </Link>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  wrap: {
    padding: theme.space.lg,
    backgroundColor: theme.colors.background,
  },
  link: {
    marginTop: theme.space.md,
    color: theme.colors.primary,
    fontWeight: '600',
    textAlign: 'center',
  },
  errorBox: {
    backgroundColor: '#FEE2E2',
    padding: theme.space.md,
    borderRadius: theme.radius.md,
    marginBottom: theme.space.md,
  },
  errorText: { color: theme.colors.danger, fontWeight: '600' },
  infoBox: {
    backgroundColor: theme.colors.primarySoft,
    padding: theme.space.md,
    borderRadius: theme.radius.md,
    marginBottom: theme.space.md,
  },
  infoText: { color: theme.colors.primaryDark, fontWeight: '600' },
});
