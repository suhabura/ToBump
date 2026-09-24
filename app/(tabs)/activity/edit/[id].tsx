import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityForm } from '@/components/ActivityForm';
import { EmptyState, Loading, Screen } from '@/components/ui';
import { useAuth } from '@/contexts/AuthContext';
import { useT } from '@/i18n';
import { userCanEditActivity } from '@/lib/api';
import { fetchSeriesFinanceSettings, seriesKey } from '@/lib/finance';
import { hasWeekdayRules, hydrateRules, rulesFromLegacy, type DateSlotRule, type RecurrenceRule } from '@/lib/recurrence';
import { supabase } from '@/lib/supabase';
import type { Activity, FundingMode, Privacy } from '@/lib/types';

export default function EditActivityScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useT();
  const { user } = useAuth();
  const [forbidden, setForbidden] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [isCreator, setIsCreator] = useState(false);
  const [initial, setInitial] = useState<{
    title: string;
    starts_at: string;
    ends_at?: string | null;
    price?: number | null;
    max_participants?: number | null;
    min_participants?: number | null;
    privacy: Privacy;
    enterprise_id?: string | null;
    venue_text?: string | null;
    venue_latitude?: number | null;
    venue_longitude?: number | null;
    category_id?: string | null;
    group_id?: string | null;
    invite_user_ids?: string[];
    editor_user_ids?: string[];
    is_recurring?: boolean;
    finance_enabled?: boolean;
    show_weather?: boolean;
    funding_mode?: FundingMode | null;
    who_pays?: import('@/lib/types').FinanceWhoPays | null;
    payer_group_id?: string | null;
    payer_user_ids?: string[];
    series_id?: string | null;
    recurrence_rules?: (RecurrenceRule | DateSlotRule)[];
    recurrence_until?: string | null;
    recurrence_dates?: string[];
    duration_minutes?: number | null;
  } | null>(null);

  useEffect(() => {
    (async () => {
      if (!user || !id) return;
      const { data } = await supabase.from('activities').select('*').eq('id', id).maybeSingle();
      if (!data) {
        setNotFound(true);
        return;
      }
      const act = data as Activity;
      const access = await userCanEditActivity(id, user.id);
      if (!access.canEdit) {
        setForbidden(true);
        return;
      }
      setIsCreator(access.isCreator);
      const [{ data: invites }, { data: editors }] = await Promise.all([
        supabase.from('activity_invites').select('user_id').eq('activity_id', id),
        supabase.from('activity_editors').select('user_id').eq('activity_id', id),
      ]);
      const start = new Date(act.starts_at);
      const fallback =
        act.duration_minutes && act.duration_minutes > 0
          ? act.duration_minutes
          : act.ends_at
            ? Math.max(15, Math.round((new Date(act.ends_at).getTime() - start.getTime()) / 60_000))
            : 90;
      const rawRules = (act.recurrence_rules ?? []) as (Partial<RecurrenceRule> & Partial<DateSlotRule>)[];
      const dateSlots = rawRules.filter(
        (rule) => typeof rule.date === 'string' && !hasWeekdayRules([rule])
      );
      const weekRules = hasWeekdayRules(rawRules)
        ? hydrateRules(rawRules, fallback)
        : act.recurrence_weekdays?.length
          ? rulesFromLegacy(act.recurrence_weekdays, start.getHours(), start.getMinutes(), fallback)
          : [];
      const rules = [...weekRules, ...dateSlots];
      const sid = seriesKey(act);
      let fundingMode: FundingMode | null = null;
      let whoPays: import('@/lib/types').FinanceWhoPays | null = null;
      let payerGroupId: string | null = null;
      let payerUserIds: string[] = [];
      let price = act.price;
      try {
        const settings = await fetchSeriesFinanceSettings(sid);
        if (settings?.funding_mode) {
          fundingMode =
            settings.funding_mode === 'annual' ? 'fixed' : (settings.funding_mode as FundingMode);
          if (settings.amount != null && (price == null || Number(price) === 0)) {
            price = Number(settings.amount);
          }
        }
        if (settings?.who_pays === 'group' || settings?.who_pays === 'selected') {
          whoPays = settings.who_pays;
        }
        payerGroupId = settings?.payer_group_id ?? null;
        payerUserIds = settings?.payer_ids ?? [];
      } catch {
        /* settings table may be missing */
      }

      const seriesInviteIds = Array.isArray(act.series_invite_user_ids)
        ? act.series_invite_user_ids
        : [];
      const occurrenceInviteIds = (invites ?? []).map((i: { user_id: string }) => i.user_id);
      setInitial({
        title: act.title,
        starts_at: act.starts_at,
        ends_at: act.ends_at,
        price,
        max_participants: act.max_participants,
        min_participants: act.min_participants ?? null,
        privacy: (act.series_privacy as Privacy) ?? act.privacy,
        enterprise_id: act.enterprise_id,
        venue_text:
          act.venue_text ??
          (act.enterprise_id ? undefined : ''),
        venue_latitude: act.venue_latitude ?? null,
        venue_longitude: act.venue_longitude ?? null,
        category_id: act.category_id,
        group_id: act.series_group_id ?? act.group_id,
        invite_user_ids: seriesInviteIds.length ? seriesInviteIds : occurrenceInviteIds,
        editor_user_ids: (editors ?? []).map((e: { user_id: string }) => e.user_id),
        is_recurring: act.is_recurring,
        finance_enabled: Boolean(act.finance_enabled),
        show_weather: Boolean(act.show_weather),
        funding_mode: fundingMode,
        who_pays: whoPays,
        payer_group_id: payerGroupId,
        payer_user_ids: payerUserIds,
        series_id: act.series_id ?? act.id,
        recurrence_rules: rules,
        recurrence_until: act.recurrence_until ?? null,
        recurrence_dates: Array.isArray(act.recurrence_dates) ? act.recurrence_dates : [],
        duration_minutes: act.duration_minutes,
      });
    })();
  }, [id, user]);

  if (!user) return <Loading />;

  if (notFound) {
    return (
      <Screen>
        <EmptyState title={t.events.notFound} />
      </Screen>
    );
  }

  if (forbidden) {
    return (
      <Screen>
        <EmptyState title={t.events.editForbidden} />
      </Screen>
    );
  }

  if (!initial) return <Loading />;

  return (
    <Screen style={{ padding: 0 }}>
      <ActivityForm userId={user.id} activityId={id} initial={initial} isCreator={isCreator} />
    </Screen>
  );
}
