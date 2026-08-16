import * as ImagePicker from 'expo-image-picker';
import { useEffect, useState } from 'react';
import { Alert, Image, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { Button, Chip, Input, Muted, Screen, Subtitle, Title } from '@/components/ui';
import { LocationField } from '@/components/LocationField';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/lib/supabase';
import { LOCALES, useLocale, useT, type Locale } from '@/i18n';
import { theme } from '@/constants/theme';

export default function ProfileScreen() {
  const t = useT();
  const { locale, setLocale } = useLocale();
  const { profile, settings, updateProfile, updateSettings, signOut, user, refreshProfile } = useAuth();
  const [firstName, setFirstName] = useState(profile?.first_name ?? '');
  const [lastName, setLastName] = useState(profile?.last_name ?? '');
  const [location, setLocation] = useState(profile?.location ?? '');
  const [latitude, setLatitude] = useState<number | null>(profile?.latitude ?? null);
  const [longitude, setLongitude] = useState<number | null>(profile?.longitude ?? null);
  const [password, setPassword] = useState('');
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);

  useEffect(() => {
    if (!profile) return;
    setFirstName(profile.first_name ?? '');
    setLastName(profile.last_name ?? '');
    setLocation(profile.location ?? '');
    setLatitude(profile.latitude ?? null);
    setLongitude(profile.longitude ?? null);
  }, [profile]);

  async function save() {
    if (!location.trim() || latitude == null || longitude == null) {
      Alert.alert(t.common.error, t.profile.locationRequired);
      return;
    }
    setSaving(true);
    const { error } = await updateProfile({
      first_name: firstName.trim(),
      last_name: lastName.trim(),
      location: location.trim(),
      latitude,
      longitude,
    });
    setSaving(false);
    if (error) Alert.alert(t.common.error, error);
    else Alert.alert('OK', t.profile.saved);
  }

  async function savePassword() {
    if (password.length < 6) {
      Alert.alert(t.common.error, 'Password must be at least 6 characters.');
      return;
    }
    setSavingPassword(true);
    const { error: pwErr } = await supabase.auth.updateUser({ password });
    setSavingPassword(false);
    if (pwErr) Alert.alert(t.common.error, pwErr.message);
    else {
      setPassword('');
      setShowPasswordForm(false);
      Alert.alert('OK', t.profile.saved);
    }
  }

  async function pickAvatar() {
    if (!user) return;
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.7,
    });
    if (res.canceled || !res.assets[0]) return;
    const asset = res.assets[0];
    const ext = asset.uri.split('.').pop() ?? 'jpg';
    const path = `${user.id}/avatar.${ext}`;
    const response = await fetch(asset.uri);
    const blob = await response.blob();
    const { error } = await supabase.storage.from('avatars').upload(path, blob, { upsert: true });
    if (error) {
      Alert.alert(t.common.error, error.message);
      return;
    }
    const { data } = supabase.storage.from('avatars').getPublicUrl(path);
    await updateProfile({ avatar_url: `${data.publicUrl}?t=${Date.now()}` });
    await refreshProfile();
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
        <Title>{t.profile.title}</Title>
        <View style={styles.avatarRow}>
          {profile?.avatar_url ? (
            <Image source={{ uri: profile.avatar_url }} style={styles.avatar} />
          ) : (
            <View style={[styles.avatar, styles.avatarPlaceholder]}>
              <Text style={{ color: '#fff', fontWeight: '700', fontSize: 24 }}>
                {(profile?.first_name?.[0] ?? 'T').toUpperCase()}
              </Text>
            </View>
          )}
          <Button label={t.profile.changePhoto} variant="secondary" onPress={pickAvatar} />
        </View>
        <Muted>{profile?.email}</Muted>
        <View style={{ height: 12 }} />
        <Input label={t.auth.firstName} value={firstName} onChangeText={setFirstName} />
        <Input label={t.auth.lastName} value={lastName} onChangeText={setLastName} />
        <LocationField
          label={t.profile.location}
          address={location}
          latitude={latitude}
          longitude={longitude}
          required
          onChange={({ address, latitude: lat, longitude: lng }) => {
            setLocation(address);
            setLatitude(lat);
            setLongitude(lng);
          }}
        />
        <Button label={t.profile.save} onPress={save} loading={saving} />

        <View style={{ height: 24 }} />
        <Subtitle>{t.profile.language}</Subtitle>
        <Muted>{t.profile.languageHint}</Muted>
        <View style={styles.langRow}>
          {LOCALES.map((item) => (
            <Chip
              key={item.code}
              label={item.label}
              active={locale === item.code}
              onPress={() => setLocale(item.code as Locale)}
            />
          ))}
        </View>

        <View style={{ height: 24 }} />
        <Subtitle>{t.profile.settings}</Subtitle>
        <SettingRow
          label={t.profile.notifyJoins}
          value={settings?.notify_activity_join ?? true}
          onChange={(v) => updateSettings({ notify_activity_join: v })}
        />
        <SettingRow
          label={t.profile.notifyMessages}
          value={settings?.notify_message ?? true}
          onChange={(v) => updateSettings({ notify_message: v })}
        />
        <SettingRow
          label={t.profile.notifyFriendRequests}
          value={settings?.notify_friend_request ?? true}
          onChange={(v) => updateSettings({ notify_friend_request: v })}
        />
        <SettingRow
          label={t.profile.notifyInvites}
          value={settings?.notify_invite ?? true}
          onChange={(v) => updateSettings({ notify_invite: v })}
        />

        <View style={{ height: 16 }} />
        <Button label={t.auth.logout} variant="danger" onPress={() => signOut()} />

        <View style={{ height: 24 }} />
        {!showPasswordForm ? (
          <Text style={styles.link} onPress={() => setShowPasswordForm(true)}>
            {t.profile.changePassword}
          </Text>
        ) : (
          <View>
            <Input
              label={t.profile.changePassword}
              secureTextEntry
              value={password}
              onChangeText={setPassword}
              placeholder={t.profile.passwordPlaceholder}
            />
            <Button label={t.profile.save} onPress={savePassword} loading={savingPassword} />
            <Text
              style={[styles.link, { marginTop: 8 }]}
              onPress={() => {
                setShowPasswordForm(false);
                setPassword('');
              }}>
              {t.common.cancel}
            </Text>
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}

function SettingRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <View style={styles.setting}>
      <Text style={styles.settingLabel}>{label}</Text>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ true: theme.colors.primary, false: theme.colors.border }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  avatarRow: { flexDirection: 'row', alignItems: 'center', gap: 16, marginBottom: 12 },
  avatar: { width: 72, height: 72, borderRadius: 36 },
  avatarPlaceholder: {
    backgroundColor: theme.colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  langRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8, marginBottom: 8 },
  setting: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  settingLabel: { color: theme.colors.text, fontSize: 15 },
  link: {
    color: theme.colors.primary,
    fontWeight: '600',
    fontSize: 15,
    textDecorationLine: 'underline',
  },
});
