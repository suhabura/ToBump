import { useAuth } from '@/contexts/AuthContext';
import { ActivityForm } from '@/components/ActivityForm';
import { Loading, Screen } from '@/components/ui';

export default function CreateActivityScreen() {
  const { user } = useAuth();
  if (!user) return <Loading />;
  return (
    <Screen style={{ padding: 0 }}>
      <ActivityForm userId={user.id} />
    </Screen>
  );
}
