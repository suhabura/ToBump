import { Screen, Title, Muted } from '@/components/ui';
import { useT } from '@/i18n';

/** Venue entry is only in app 2 (providers). */
export default function CreateEnterpriseScreen() {
  const t = useT();
  return (
    <Screen>
      <Title>{t.venue.title}</Title>
      <Muted>{t.venue.app2Only}</Muted>
      <Muted>{t.venue.app2Hint}</Muted>
    </Screen>
  );
}
