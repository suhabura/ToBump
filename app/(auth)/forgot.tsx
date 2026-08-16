import { useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { Button, Input, Muted, Title } from '@/components/ui';
import { useAuth } from '@/contexts/AuthContext';
import { useT } from '@/i18n';
import { theme } from '@/constants/theme';

export default function ForgotScreen() {
  const t = useT();
  const { resetPassword } = useAuth();
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);

  async function onSubmit() {
    setLoading(true);
    const { error } = await resetPassword(email);
    setLoading(false);
    if (error) Alert.alert(t.common.error, error);
    else Alert.alert('OK', t.auth.resetSent);
  }

  return (
    <View style={styles.wrap}>
      <Title>{t.auth.forgot}</Title>
      <Muted>Enter your account email and we’ll send a password reset link.</Muted>
      <View style={{ height: 16 }} />
      <Input label={t.auth.email} autoCapitalize="none" value={email} onChangeText={setEmail} />
      <Button label={t.auth.sendReset} onPress={onSubmit} loading={loading} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    padding: theme.space.lg,
    backgroundColor: theme.colors.background,
  },
});
