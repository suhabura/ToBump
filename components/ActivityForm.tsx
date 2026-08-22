import { useEffect, useMemo, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Button, Chip, Input, Muted } from '@/components/ui';
import { DateTimeField } from '@/components/DateTimeField';
import { LocationField } from '@/components/LocationField';
import { SuggestInput } from '@/components/SuggestInput';
import { FriendPicker } from '@/components/FriendPicker';
import {
  DEFAULT_SUBCATEGORIES,
  MAIN_CATEGORY_NAMES,
  ensureDefaultCategories,
  findCategoryId,
  saveActivity,
  type ActivityInput,
} from '@/lib/api';
import { dedupeProfilesByEmail } from '@/lib/friends';
import {
  clearSeriesFinanceSettings,
  ensureFundingExpenses,
  seriesKey,
  upsertSeriesFinanceSettings,
} from '@/lib/finance';
import { formatDuration, formatRecurrence, formatTime, hydrateRules, isoWeekday, normalizeRules, rulesFromLegacy, WEEKDAY_OPTIONS, type RecurrenceRule } from '@/lib/recurrence';
import { supabase } from '@/lib/supabase';
import type { Category, Enterprise, FinanceWhoPays, FundingMode, Privacy, Profile } from '@/lib/types';
import { categoryDisplayName, resolveActivityCategoryKey, useLocale, useT } from '@/i18n';
import { theme } from '@/constants/theme';
import { useAuth } from '@/contexts/AuthContext';

type Props = {
  userId: string;
  activityId?: string;
  /** Only the creator can assign co-editors (true for new events) */
  isCreator?: boolean;
  initial?: Partial<ActivityInput> & {
    invite_user_ids?: string[];
    editor_user_ids?: string[];
    group_id?: string | null;
    series_id?: string | null;
    funding_mode?: FundingMode | null;
    who_pays?: FinanceWhoPays | null;
    payer_group_id?: string | null;
    payer_user_ids?: string[];
  };
};

function parseInitialDate(value?: string | null) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function defaultDurationFromInitial(initial?: Props['initial']): number {
  if (initial?.duration_minutes && initial.duration_minutes > 0) return initial.duration_minutes;
  const s = parseInitialDate(initial?.starts_at);
  const e = parseInitialDate(initial?.ends_at);
  if (s && e && e > s) return Math.max(15, Math.round((e.getTime() - s.getTime()) / 60_000));
  return 90;
}

function initialRules(initial?: Props['initial']): RecurrenceRule[] {
  const fallback = defaultDurationFromInitial(initial);
  if (initial?.recurrence_rules?.length) return hydrateRules(initial.recurrence_rules, fallback);
  if (initial?.is_recurring && initial.starts_at) {
    const d = parseInitialDate(initial.starts_at);
    if (d && (initial as { recurrence_weekdays?: number[] }).recurrence_weekdays?.length) {
      return rulesFromLegacy(
        (initial as { recurrence_weekdays?: number[] }).recurrence_weekdays!,
        d.getHours(),
        d.getMinutes(),
        fallback
      );
    }
  }
  return [];
}

export function ActivityForm({ userId, activityId, initial, isCreator = true }: Props) {
  const router = useRouter();
  const t = useT();
  const { locale } = useLocale();
  const { profile } = useAuth();
  const [title, setTitle] = useState(() => {
    const raw = initial?.title ?? '';
    const key = resolveActivityCategoryKey(raw);
    return key ? categoryDisplayName(key, locale) : raw;
  });
  const [startsAt, setStartsAt] = useState<Date | null>(parseInitialDate(initial?.starts_at));
  const [price, setPrice] = useState(String(initial?.price ?? '0'));
  const [capacity, setCapacity] = useState(initial?.max_participants ? String(initial.max_participants) : '');
  const [privacy, setPrivacy] = useState<Privacy>(initial?.privacy ?? 'invite');
  const [enterpriseId, setEnterpriseId] = useState<string | null>(initial?.enterprise_id ?? null);
  const [venueText, setVenueText] = useState(initial?.venue_text ?? '');
  const [venueLatitude, setVenueLatitude] = useState<number | null>(initial?.venue_latitude ?? null);
  const [venueLongitude, setVenueLongitude] = useState<number | null>(initial?.venue_longitude ?? null);
  const [matchedCategoryId, setMatchedCategoryId] = useState<string | null>(initial?.category_id ?? null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [enterprises, setEnterprises] = useState<Enterprise[]>([]);
  const [friends, setFriends] = useState<Profile[]>([]);
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(initial?.group_id ?? null);
  const [inviteIds, setInviteIds] = useState<string[]>(initial?.invite_user_ids ?? []);
  const [editorIds, setEditorIds] = useState<string[]>(initial?.editor_user_ids ?? []);
  const [showEditors, setShowEditors] = useState(Boolean(initial?.editor_user_ids?.length));
  const [isRecurring, setIsRecurring] = useState(Boolean(initial?.is_recurring));
  const [financeEnabled, setFinanceEnabled] = useState(Boolean(initial?.finance_enabled));
  const [fundingMode, setFundingMode] = useState<FundingMode>(
    initial?.funding_mode && ['per_event', 'monthly', 'fixed', 'annual'].includes(initial.funding_mode)
      ? initial.funding_mode === 'annual'
        ? 'fixed'
        : (initial.funding_mode as FundingMode)
      : 'per_event'
  );
  const [whoPays, setWhoPays] = useState<FinanceWhoPays>(
    initial?.who_pays === 'group' ? 'group' : 'selected'
  );
  const [payerIds, setPayerIds] = useState<string[]>(initial?.payer_user_ids ?? []);
  const [payerGroupId, setPayerGroupId] = useState<string | null>(initial?.payer_group_id ?? null);
  const [rules, setRules] = useState<RecurrenceRule[]>(() => initialRules(initial));
  const [recurrenceUntil, setRecurrenceUntil] = useState<Date | null>(() => {
    const raw = (initial as { recurrence_until?: string | null } | undefined)?.recurrence_until;
    if (!raw) return null;
    const d = new Date(`${raw}T12:00:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  });
  const [durationMinutes, setDurationMinutes] = useState(() => defaultDurationFromInitial(initial));
  const [loading, setLoading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Only English canonical names from seed + DB English rows — show localized labels once
  const activitySuggestions = useMemo(() => {
    const englishKeys = new Set(DEFAULT_SUBCATEGORIES);
    for (const c of categories) {
      if (MAIN_CATEGORY_NAMES.some((m) => m.toLowerCase() === c.name.toLowerCase())) continue;
      if (DEFAULT_SUBCATEGORIES.some((k) => k.toLowerCase() === c.name.toLowerCase())) {
        englishKeys.add(DEFAULT_SUBCATEGORIES.find((k) => k.toLowerCase() === c.name.toLowerCase())!);
      }
    }
    return Array.from(englishKeys).map((key) => categoryDisplayName(key, locale));
  }, [categories, locale]);

  useEffect(() => {
    const key = resolveActivityCategoryKey(title, locale);
    if (key) setTitle(categoryDisplayName(key, locale));
    // Re-label when UI language changes; ignore free-text that isn't a known category
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale]);

  const isCategorized = Boolean(matchedCategoryId);

  const selectedEnterprise = enterprises.find((e) => e.id === enterpriseId) ?? null;

  const venueAddress =
    selectedEnterprise != null
      ? selectedEnterprise.address?.trim()
        ? `${selectedEnterprise.name} · ${selectedEnterprise.address.trim()}`
        : selectedEnterprise.name
      : venueText;

  const venueLat =
    selectedEnterprise?.latitude != null ? selectedEnterprise.latitude : venueLatitude;
  const venueLng =
    selectedEnterprise?.longitude != null ? selectedEnterprise.longitude : venueLongitude;

  const profileOrigin =
    profile?.latitude != null && profile?.longitude != null
      ? { latitude: profile.latitude, longitude: profile.longitude }
      : null;

  function onVenueLocationChange(next: {
    address: string;
    latitude: number | null;
    longitude: number | null;
  }) {
    setEnterpriseId(null);
    setVenueText(next.address);
    setVenueLatitude(next.latitude);
    setVenueLongitude(next.longitude);
  }

  function clearVenue() {
    setEnterpriseId(null);
    setVenueText('');
    setVenueLatitude(null);
    setVenueLongitude(null);
  }

  useEffect(() => {
    if (!enterpriseId || venueText.trim()) return;
    const ent = enterprises.find((e) => e.id === enterpriseId);
    if (ent) {
      const label = ent.address?.trim() ? `${ent.name} · ${ent.address.trim()}` : ent.name;
      setVenueText(label);
      setVenueLatitude(ent.latitude ?? null);
      setVenueLongitude(ent.longitude ?? null);
    }
  }, [enterpriseId, enterprises, venueText]);

  useEffect(() => {
    (async () => {
      await ensureDefaultCategories();
      const [{ data: cats }, { data: ents }, groupsRes] = await Promise.all([
        supabase.from('categories').select('*').order('name'),
        supabase.from('enterprises').select('*').order('name'),
        supabase.from('friend_groups').select('id, name').eq('created_by', userId).order('name'),
      ]);
      setCategories((cats as Category[]) ?? []);
      setEnterprises((ents as Enterprise[]) ?? []);
      setGroups((groupsRes.data as { id: string; name: string }[]) ?? []);

      const { data: fr } = await supabase
        .from('friendships')
        .select('*')
        .eq('status', 'accepted')
        .or(`from_user_id.eq.${userId},to_user_id.eq.${userId}`);
      const otherIds = Array.from(
        new Set(
          (fr ?? []).map((f: { from_user_id: string; to_user_id: string }) =>
            f.from_user_id === userId ? f.to_user_id : f.from_user_id
          )
        )
      );
      if (otherIds.length) {
        const { data: profiles } = await supabase.from('profiles').select('*').in('id', otherIds);
        setFriends(dedupeProfilesByEmail((profiles as Profile[]) ?? []));
      }
    })();
  }, [userId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const id = await findCategoryId(title);
      if (cancelled) return;
      setMatchedCategoryId(id);
      if (!id) {
        setEnterpriseId(null);
        return;
      }
      setEnterpriseId((prev) => {
        if (!prev) return null;
        const ent = enterprises.find((e) => e.id === prev);
        if (!ent?.category_id) return prev;
        if (ent.category_id === id) return prev;
        const sub = categories.find((c) => c.id === id);
        const parentId = sub?.parent_id ?? null;
        if (parentId && ent.category_id === parentId) return prev;
        const entCat = categories.find((c) => c.id === ent.category_id);
        if (parentId && entCat?.parent_id === parentId) return prev;
        return null;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [title, enterprises, categories]);

  function toggleWeekday(day: number) {
    setRules((prev) => {
      if (prev.some((r) => r.weekday === day)) {
        return prev.filter((r) => r.weekday !== day);
      }
      const hour = startsAt?.getHours() ?? 19;
      const minute = startsAt ? (Math.round(startsAt.getMinutes() / 15) * 15) % 60 : 0;
      const duration_minutes =
        prev[0]?.duration_minutes ?? defaultDurationFromInitial(initial);
      return normalizeRules([...prev, { weekday: day, hour, minute, duration_minutes }]);
    });
  }

  function bumpRuleTime(day: number, part: 'hour' | 'minute', delta: number) {
    setRules((prev) =>
      normalizeRules(
        prev.map((r) => {
          if (r.weekday !== day) return r;
          if (part === 'hour') {
            return { ...r, hour: (r.hour + delta + 24) % 24 };
          }
          const nextMin = r.minute + delta * 15;
          let hour = r.hour;
          let minute = nextMin;
          if (minute >= 60) {
            minute = 0;
            hour = (hour + 1) % 24;
          } else if (minute < 0) {
            minute = 45;
            hour = (hour + 23) % 24;
          }
          return { ...r, hour, minute };
        })
      )
    );
  }

  function bumpRuleDuration(day: number, deltaMinutes: number) {
    setRules((prev) =>
      normalizeRules(
        prev.map((r) =>
          r.weekday === day
            ? { ...r, duration_minutes: Math.max(15, r.duration_minutes + deltaMinutes) }
            : r
        )
      )
    );
  }

  function setRecurring(on: boolean) {
    setIsRecurring(on);
    if (on && rules.length === 0 && startsAt) {
      setRules([
        {
          weekday: isoWeekday(startsAt),
          hour: startsAt.getHours(),
          minute: (Math.round(startsAt.getMinutes() / 15) * 15) % 60,
          duration_minutes: defaultDurationFromInitial(initial),
        },
      ]);
    }
    if (!on) {
      setRules([]);
      setRecurrenceUntil(null);
      setFundingMode('per_event');
    }
  }

  async function onSave() {
    setFormError(null);
    if (!title.trim() || !startsAt) {
      setFormError(t.form.needActivityStart);
      return;
    }
    if (startsAt.getTime() < Date.now() - 30_000) {
      setFormError(t.form.pastNotAllowed);
      return;
    }
    const normalized = normalizeRules(rules);
    if (isRecurring && normalized.length === 0) {
      setFormError(t.form.needWeekday);
      return;
    }
    if (isRecurring && normalized.some((r) => r.duration_minutes < 15)) {
      setFormError(t.form.needDurationPerDay);
      return;
    }
    if (!isRecurring && durationMinutes < 15) {
      setFormError(t.form.minDuration);
      return;
    }
    let startToSave = startsAt;
    if (isRecurring) {
      const startDay = isoWeekday(startsAt);
      if (!normalized.some((r) => r.weekday === startDay)) {
        setFormError(t.form.startMustMatchWeekday);
        return;
      }
      const rule = normalized.find((r) => r.weekday === startDay)!;
      startToSave = new Date(startsAt);
      startToSave.setHours(rule.hour, rule.minute, 0, 0);
      if (!recurrenceUntil) {
        setFormError(t.form.needSeriesEnd);
        return;
      }
      const untilDay = formatDay(recurrenceUntil);
      const startDayStr = formatDay(startToSave);
      if (untilDay < startDayStr) {
        setFormError(t.form.seriesEndBeforeStart);
        return;
      }
    }

    if (privacy === 'group' && !selectedGroupId) {
      setFormError(t.form.needGroup);
      return;
    }
    if (privacy === 'friends' && friends.length === 0) {
      setFormError(t.form.noFriends);
      return;
    }
    if (privacy === 'invite' && inviteIds.length === 0) {
      setFormError(t.form.needInviteFriends);
      return;
    }
    if (privacy === 'friends_of_friends' && inviteIds.length === 0 && !selectedGroupId) {
      setFormError(t.form.fofNeedInviteOrGroup);
      return;
    }

    const priceTrim = financeEnabled ? price.trim() : '0';
    if (financeEnabled) {
      if (priceTrim === '' || Number.isNaN(Number(priceTrim)) || Number(priceTrim) < 0) {
        setFormError(t.form.needPrice);
        return;
      }
      if (whoPays === 'selected' && payerIds.filter((id) => id !== userId).length === 0) {
        setFormError(t.form.needPayers);
        return;
      }
      if (whoPays === 'group' && !payerGroupId) {
        setFormError(t.form.needPayerGroup);
        return;
      }
    }
    const priceNum = Number(priceTrim) || 0;
    const modeToSave: FundingMode = isRecurring ? fundingMode : 'per_event';

    const capacityTrim = capacity.trim();
    if (!/^\d+$/.test(capacityTrim) || Number(capacityTrim) < 1) {
      setFormError(t.form.needCapacity);
      return;
    }
    const capacityNum = Number(capacityTrim);

    if (!enterpriseId && !venueText.trim()) {
      setFormError(t.form.needVenue);
      return;
    }

    setLoading(true);
    try {
      const categoryKey = resolveActivityCategoryKey(title, locale);
      // Prefer already-resolved category; only one lookup if still pending.
      const category_id = categoryKey
        ? matchedCategoryId ?? (await findCategoryId(categoryKey))
        : null;
      const titleToSave = (categoryKey ?? title.trim()).trim();
      if (!titleToSave) {
        setFormError(t.form.needActivityStart);
        return;
      }

      const id = await saveActivity(
        userId,
        {
          title: titleToSave,
          category_id,
          starts_at: startToSave.toISOString(),
          ends_at: null,
          duration_minutes: isRecurring ? null : durationMinutes,
          price: financeEnabled ? priceNum : 0,
          max_participants: capacityNum,
          privacy,
          enterprise_id: category_id ? enterpriseId : null,
          venue_text: enterpriseId && category_id ? null : venueText.trim() || null,
          venue_latitude: enterpriseId && category_id ? null : venueLatitude,
          venue_longitude: enterpriseId && category_id ? null : venueLongitude,
          group_id: selectedGroupId,
          invite_user_ids: inviteIds,
          editor_user_ids: isCreator ? editorIds : undefined,
          is_recurring: isRecurring,
          finance_enabled: financeEnabled,
          recurrence_rules: isRecurring ? normalized : [],
          recurrence_until: isRecurring && recurrenceUntil ? formatDay(recurrenceUntil) : null,
        },
        activityId
      );

      const sid = seriesKey({ id, series_id: initial?.series_id ?? null });
      if (financeEnabled) {
        await upsertSeriesFinanceSettings({
          seriesId: sid,
          fundingMode: modeToSave === 'annual' ? 'fixed' : modeToSave,
          amount: priceNum,
          whoPays,
          payerGroupId: whoPays === 'group' ? payerGroupId : null,
          payerIds: whoPays === 'selected' ? payerIds.filter((id) => id !== userId) : [],
          userId,
        });
        try {
          await ensureFundingExpenses({
            activity: {
              id,
              series_id: initial?.series_id ?? null,
              created_by: userId,
              finance_enabled: true,
              title: titleToSave,
              starts_at: startToSave.toISOString(),
            },
            settings: {
              series_id: sid,
              funding_mode: modeToSave === 'annual' ? 'fixed' : modeToSave,
              amount: priceNum,
              who_pays: whoPays,
              payer_group_id: whoPays === 'group' ? payerGroupId : null,
              payer_ids: whoPays === 'selected' ? payerIds.filter((id) => id !== userId) : [],
              currency: 'EUR',
              updated_by: userId,
              updated_at: new Date().toISOString(),
              created_at: new Date().toISOString(),
            },
          });
        } catch {
          /* fees created when someone first attends / Finance tab syncs */
        }
      } else {
        try {
          await clearSeriesFinanceSettings(sid);
        } catch {
          /* optional table */
        }
      }

      router.replace(`/activity/${id}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : t.common.error;
      const friendly =
        /activities_privacy_check|friends_of_friends/i.test(msg)
          ? t.form.fofDbFix
          : msg;
      setFormError(friendly);
      Alert.alert(t.common.error, friendly);
    } finally {
      setLoading(false);
    }
  }

  const req = (label: string) => `${label} *`;

  return (
    <ScrollView contentContainerStyle={styles.wrap} keyboardShouldPersistTaps="handled">
      {formError ? <Text style={styles.error}>{formError}</Text> : null}
      <SuggestInput
        label={req(t.form.activity)}
        value={title}
        onChangeText={setTitle}
        suggestions={activitySuggestions}
        placeholder={t.form.activityPlaceholder}
        resolveAlias={(text) => {
          const key = resolveActivityCategoryKey(text, locale);
          return key ? categoryDisplayName(key, locale) : null;
        }}
      />
      {title.trim() ? (
        <Muted>
          {isCategorized
            ? t.form.knownActivity
            : t.form.uncategorizedProviders}
        </Muted>
      ) : null}

      <DateTimeField label={req(t.events.starts)} value={startsAt} onChange={setStartsAt} minimumDate={new Date()} />
      {!isRecurring ? (
        <View style={{ marginBottom: theme.space.md }}>
          <Text style={styles.durationLabel}>{req(t.form.duration)}</Text>
          <View style={styles.durationRow}>
            <View style={styles.durationBlock}>
              <Chip label="−1h" active={false} onPress={() => setDurationMinutes((m) => Math.max(15, m - 60))} />
              <Chip label="−30m" active={false} onPress={() => setDurationMinutes((m) => Math.max(15, m - 30))} />
              <Chip label="−15m" active={false} onPress={() => setDurationMinutes((m) => Math.max(15, m - 15))} />
              <Text style={styles.durationValue}>{formatDuration(durationMinutes)}</Text>
              <Chip label="+15m" active={false} onPress={() => setDurationMinutes((m) => m + 15)} />
              <Chip label="+30m" active={false} onPress={() => setDurationMinutes((m) => m + 30)} />
              <Chip label="+1h" active={false} onPress={() => setDurationMinutes((m) => m + 60)} />
            </View>
          </View>
        </View>
      ) : null}
      <Input
        label={req(t.events.capacity)}
        value={capacity}
        onChangeText={(v) => setCapacity(v.replace(/[^\d]/g, ''))}
        keyboardType="number-pad"
        placeholder="e.g. 4"
      />
      <Muted>{t.form.capacityHint}</Muted>

      <Text style={styles.section}>{req(t.form.whoInvite)}</Text>
      <View style={styles.row}>
        {(
          [
            { key: 'invite' as const, label: t.events.inviteOnly },
            { key: 'group' as const, label: t.events.group },
            { key: 'friends' as const, label: t.events.friendsOnly },
            { key: 'friends_of_friends' as const, label: t.events.friendsOfFriends },
          ] as const
        ).map((p) => (
          <Chip
            key={p.key}
            label={p.label}
            active={privacy === p.key}
            onPress={() => setPrivacy(p.key)}
          />
        ))}
      </View>

      {privacy === 'invite' ? (
        <View>
          <Text style={styles.section}>{req(t.form.selectFriends)}</Text>
          {friends.length === 0 ? <Muted>{t.form.acceptFriendsHint}</Muted> : null}
          <FriendPicker
            friends={friends}
            selectedIds={inviteIds}
            onChange={setInviteIds}
            label={t.form.selectFriends}
            placeholder={t.form.searchFriends}
            emptyHint={t.form.noFriends}
          />
        </View>
      ) : null}

      {privacy === 'friends' ? (
        <Muted>{t.form.allFriendsInvited(friends.length)}</Muted>
      ) : null}

      {privacy === 'group' ? (
        <View>
          <Text style={styles.section}>{req(t.form.selectGroup)}</Text>
          {groups.length === 0 ? (
            <Muted>{t.form.noGroups}</Muted>
          ) : (
            <View style={styles.rowWrap}>
              {groups.map((g) => (
                <Chip
                  key={g.id}
                  label={g.name}
                  active={selectedGroupId === g.id}
                  onPress={() => setSelectedGroupId(g.id)}
                />
              ))}
            </View>
          )}
          <Button label={t.form.manageGroups} variant="secondary" onPress={() => router.push('/groups')} />
        </View>
      ) : null}

      {privacy === 'friends_of_friends' ? (
        <View>
          <Muted>{t.form.fofHint}</Muted>
          <Text style={styles.section}>{req(t.form.selectFriends)}</Text>
          {friends.length === 0 ? <Muted>{t.form.acceptFriendsHint}</Muted> : null}
          <FriendPicker
            friends={friends}
            selectedIds={inviteIds}
            onChange={setInviteIds}
            label={t.form.selectFriends}
            placeholder={t.form.searchFriends}
            emptyHint={t.form.noFriends}
          />
          <Text style={styles.section}>{t.form.orSelectGroup}</Text>
          {groups.length === 0 ? (
            <Muted>{t.form.noGroups}</Muted>
          ) : (
            <View style={styles.rowWrap}>
              {groups.map((g) => (
                <Chip
                  key={g.id}
                  label={g.name}
                  active={selectedGroupId === g.id}
                  onPress={() => setSelectedGroupId(selectedGroupId === g.id ? null : g.id)}
                />
              ))}
            </View>
          )}
          <Button label={t.form.manageGroups} variant="secondary" onPress={() => router.push('/groups')} />
        </View>
      ) : null}

      <View>
        <Text style={styles.section}>{req(t.events.venue)}</Text>
        <Muted>{isCategorized ? t.venue.freeTextHint : t.form.uncategorizedVenueHint}</Muted>
        <LocationField
          label={t.events.venue}
          address={venueAddress}
          latitude={venueLat}
          longitude={venueLng}
          relativeTo={profileOrigin}
          showMyLocation={false}
          allowManualConfirm
          onChange={onVenueLocationChange}
        />

        {(enterpriseId && isCategorized) || venueText.trim() ? (
          <Button label={t.venue.clear} variant="ghost" onPress={clearVenue} />
        ) : null}
      </View>

      <Text style={styles.section}>{req(t.form.recurrence)}</Text>
      <View style={styles.row}>
        <Chip label={t.events.once} active={!isRecurring} onPress={() => setRecurring(false)} />
        <Chip label={t.events.recurring} active={isRecurring} onPress={() => setRecurring(true)} />
      </View>
      {isRecurring ? (
        <View>
          <Muted>{t.form.recurrenceHint}</Muted>
          <View style={styles.rowWrap}>
            {WEEKDAY_OPTIONS.map((d) => (
              <Chip
                key={d.value}
                label={d.short}
                active={rules.some((r) => r.weekday === d.value)}
                onPress={() => toggleWeekday(d.value)}
              />
            ))}
          </View>
          {rules.map((r) => {
            const day = WEEKDAY_OPTIONS.find((w) => w.value === r.weekday);
            return (
              <View key={r.weekday} style={styles.ruleCard}>
                <Text style={styles.ruleDay}>{day?.label ?? r.weekday}</Text>
                <Text style={styles.ruleSub}>{t.form.start}</Text>
                <View style={styles.ruleTime}>
                  <Chip label="−1h" active={false} onPress={() => bumpRuleTime(r.weekday, 'hour', -1)} />
                  <Text style={styles.ruleTimeText}>{formatTime(r.hour, r.minute)}</Text>
                  <Chip label="+1h" active={false} onPress={() => bumpRuleTime(r.weekday, 'hour', 1)} />
                  <Chip label="−15m" active={false} onPress={() => bumpRuleTime(r.weekday, 'minute', -1)} />
                  <Chip label="+15m" active={false} onPress={() => bumpRuleTime(r.weekday, 'minute', 1)} />
                </View>
                <Text style={styles.ruleSub}>{t.form.duration}</Text>
                <View style={styles.ruleTime}>
                  <Chip label="−1h" active={false} onPress={() => bumpRuleDuration(r.weekday, -60)} />
                  <Chip label="−30m" active={false} onPress={() => bumpRuleDuration(r.weekday, -30)} />
                  <Chip label="−15m" active={false} onPress={() => bumpRuleDuration(r.weekday, -15)} />
                  <Text style={styles.ruleTimeText}>{formatDuration(r.duration_minutes)}</Text>
                  <Chip label="+15m" active={false} onPress={() => bumpRuleDuration(r.weekday, 15)} />
                  <Chip label="+30m" active={false} onPress={() => bumpRuleDuration(r.weekday, 30)} />
                  <Chip label="+1h" active={false} onPress={() => bumpRuleDuration(r.weekday, 60)} />
                </View>
              </View>
            );
          })}
          {rules.length ? <Muted>{formatRecurrence(rules)}</Muted> : null}
          <View style={{ height: 8 }} />
          <DateTimeField
            label={req(t.form.seriesEnds)}
            value={recurrenceUntil}
            onChange={setRecurrenceUntil}
            mode="date"
            minimumDate={startsAt ?? new Date()}
          />
        </View>
      ) : null}

      <Text style={styles.section}>{t.form.finance}</Text>
      <Muted>{t.form.financeHint}</Muted>
      <View style={styles.row}>
        <Chip
          label={t.form.financeOff}
          active={!financeEnabled}
          onPress={() => setFinanceEnabled(false)}
        />
        <Chip
          label={t.form.financeOn}
          active={financeEnabled}
          onPress={() => setFinanceEnabled(true)}
        />
      </View>
      {financeEnabled ? (
        <View style={{ marginTop: 12, gap: 8 }}>
          <Muted>{t.form.fundingMode}</Muted>
          <View style={styles.rowWrap}>
            <Chip
              label={t.form.payPerEvent}
              active={fundingMode === 'per_event'}
              onPress={() => setFundingMode('per_event')}
            />
            {isRecurring ? (
              <>
                <Chip
                  label={t.form.payMonthly}
                  active={fundingMode === 'monthly'}
                  onPress={() => setFundingMode('monthly')}
                />
                <Chip
                  label={t.form.payFixed}
                  active={fundingMode === 'fixed' || fundingMode === 'annual'}
                  onPress={() => setFundingMode('fixed')}
                />
              </>
            ) : null}
          </View>
          <Muted>{t.form.whoPays}</Muted>
          <View style={styles.rowWrap}>
            <Chip
              label={t.form.whoPaysSelected}
              active={whoPays === 'selected'}
              onPress={() => setWhoPays('selected')}
            />
            <Chip
              label={t.form.whoPaysGroup}
              active={whoPays === 'group'}
              onPress={() => setWhoPays('group')}
            />
          </View>
          <Muted>{t.form.whoPaysHint}</Muted>
          {whoPays === 'selected' ? (
            <FriendPicker
              friends={friends}
              selectedIds={payerIds}
              onChange={setPayerIds}
              label={t.form.whoPaysPeople}
              placeholder={t.form.searchFriends}
              emptyHint={t.form.noFriends}
            />
          ) : (
            <View style={styles.rowWrap}>
              {groups.length === 0 ? <Muted>{t.form.noGroups}</Muted> : null}
              {groups.map((g) => (
                <Chip
                  key={g.id}
                  label={g.name}
                  active={payerGroupId === g.id}
                  onPress={() => setPayerGroupId(payerGroupId === g.id ? null : g.id)}
                />
              ))}
            </View>
          )}
          <Input
            label={
              fundingMode === 'monthly'
                ? t.form.priceMonthly
                : fundingMode === 'fixed' || fundingMode === 'annual'
                  ? t.form.priceFixed
                  : t.form.pricePerEvent
            }
            value={price}
            onChangeText={setPrice}
            keyboardType="decimal-pad"
            placeholder="0"
          />
          <Muted>
            {fundingMode === 'monthly'
              ? t.form.priceMonthlyHint
              : fundingMode === 'fixed' || fundingMode === 'annual'
                ? t.form.priceFixedHint
                : t.form.pricePerEventHint}
          </Muted>
        </View>
      ) : null}

      {isCreator ? (
        <View style={{ marginTop: 16 }}>
          {!showEditors ? (
            <Text style={styles.link} onPress={() => setShowEditors(true)}>
              {t.form.addEditors}
            </Text>
          ) : (
            <View>
              <Text style={styles.section}>{t.form.editors}</Text>
              <Muted>{t.form.editorsHint}</Muted>
              <FriendPicker
                friends={friends}
                selectedIds={editorIds}
                onChange={setEditorIds}
                label={t.form.editors}
                placeholder={t.form.searchFriends}
                emptyHint={t.form.noFriends}
              />
              <Text
                style={[styles.link, { marginTop: 8 }]}
                onPress={() => {
                  setShowEditors(false);
                  setEditorIds(initial?.editor_user_ids ?? []);
                }}>
                {t.common.cancel}
              </Text>
            </View>
          )}
        </View>
      ) : null}

      <View style={{ height: 16 }} />
      <Button label={t.events.save} onPress={onSave} loading={loading} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { padding: theme.space.md, paddingBottom: 48, backgroundColor: theme.colors.background },
  section: { fontWeight: '700', marginTop: 8, marginBottom: 8, color: theme.colors.text },
  row: { flexDirection: 'row', marginBottom: 12, flexWrap: 'wrap' },
  rowWrap: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 12, gap: 4 },
  ruleCard: {
    marginBottom: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radius.sm,
    borderWidth: 1,
    borderColor: theme.colors.border,
    gap: 6,
  },
  ruleDay: { fontWeight: '700', color: theme.colors.text, fontSize: 15 },
  ruleSub: { fontSize: 12, fontWeight: '600', color: theme.colors.textMuted, marginTop: 4 },
  ruleTime: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4 },
  ruleTimeText: { fontSize: 16, fontWeight: '800', color: theme.colors.text, minWidth: 64, textAlign: 'center' },
  durationLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: theme.colors.textMuted,
    marginBottom: 6,
  },
  durationRow: { flexDirection: 'row', alignItems: 'center' },
  durationBlock: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  durationValue: { fontSize: 18, fontWeight: '800', color: theme.colors.text, minWidth: 72, textAlign: 'center' },
  error: {
    color: theme.colors.danger,
    backgroundColor: '#FEE2E2',
    padding: 12,
    borderRadius: theme.radius.sm,
    marginBottom: 12,
    fontWeight: '600',
  },
  link: {
    color: theme.colors.primary,
    fontWeight: '600',
    fontSize: 15,
    textDecorationLine: 'underline',
  },
});
