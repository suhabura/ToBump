import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { isSupabaseConfigured, supabase } from '@/lib/supabase';
import type { Profile, UserSettings } from '@/lib/types';
import { registerForPushNotifications } from '@/lib/notifications';

type AuthContextValue = {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  settings: UserSettings | null;
  loading: boolean;
  configured: boolean;
  refreshProfile: () => Promise<void>;
  refreshSettings: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<{ error?: string }>;
  signUp: (email: string, password: string, firstName: string, lastName: string) => Promise<{ error?: string }>;
  signOut: () => Promise<void>;
  resetPassword: (email: string) => Promise<{ error?: string }>;
  updateProfile: (patch: Partial<Profile>) => Promise<{ error?: string }>;
  updateSettings: (patch: Partial<UserSettings>) => Promise<{ error?: string }>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [settings, setSettings] = useState<UserSettings | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshProfile = useCallback(async () => {
    const uid = (await supabase.auth.getUser()).data.user?.id;
    if (!uid) {
      setProfile(null);
      return;
    }
    const { data } = await supabase.from('profiles').select('*').eq('id', uid).maybeSingle();
    setProfile((data as Profile) ?? null);
  }, []);

  const refreshSettings = useCallback(async () => {
    const uid = (await supabase.auth.getUser()).data.user?.id;
    if (!uid) {
      setSettings(null);
      return;
    }
    const { data } = await supabase.from('user_settings').select('*').eq('user_id', uid).maybeSingle();
    setSettings((data as UserSettings) ?? null);
  }, []);

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setLoading(false);
      return;
    }

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session?.user) {
      setProfile(null);
      setSettings(null);
      return;
    }
    refreshProfile();
    refreshSettings();
    registerForPushNotifications().then(async (token) => {
      if (!token) return;
      await supabase
        .from('user_settings')
        .update({ push_token: token })
        .eq('user_id', session.user.id);
    });
  }, [session?.user?.id, refreshProfile, refreshSettings]);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user: session?.user ?? null,
      profile,
      settings,
      loading,
      configured: isSupabaseConfigured,
      refreshProfile,
      refreshSettings,
      async signIn(email, password) {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        return { error: error?.message };
      },
      async signUp(email, password, firstName, lastName) {
        const { error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: {
            data: { first_name: firstName.trim(), last_name: lastName.trim() },
          },
        });
        return { error: error?.message };
      },
      async signOut() {
        await supabase.auth.signOut();
      },
      async resetPassword(email) {
        const { error } = await supabase.auth.resetPasswordForEmail(email.trim());
        return { error: error?.message };
      },
      async updateProfile(patch) {
        if (!session?.user) return { error: 'Ni seje' };
        const { error } = await supabase.from('profiles').update(patch).eq('id', session.user.id);
        if (!error) await refreshProfile();
        return { error: error?.message };
      },
      async updateSettings(patch) {
        if (!session?.user) return { error: 'Ni seje' };
        const { error } = await supabase.from('user_settings').update(patch).eq('user_id', session.user.id);
        if (error) {
          // Locale column may be missing until SQL migration is run — keep UI language local
          if (patch.locale && /locale/i.test(error.message)) {
            setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
            return {};
          }
          return { error: error.message };
        }
        await refreshSettings();
        return {};
      },
    }),
    [session, profile, settings, loading, refreshProfile, refreshSettings]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
