import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

export type EventsHeaderControls = {
  search: string;
  searchOpen: boolean;
  onSearchChange: (q: string) => void;
  onSearchOpen: () => void;
  onSearchClose: () => void;
  onSearchSubmit: () => void;
  onCreate: () => void;
} | null;

type EventsHeaderContextValue = {
  controls: EventsHeaderControls;
  setControls: (c: EventsHeaderControls) => void;
};

const EventsHeaderContext = createContext<EventsHeaderContextValue | null>(null);

export function EventsHeaderProvider({ children }: { children: ReactNode }) {
  const [controls, setControls] = useState<EventsHeaderControls>(null);
  const value = useMemo(() => ({ controls, setControls }), [controls]);
  return <EventsHeaderContext.Provider value={value}>{children}</EventsHeaderContext.Provider>;
}

export function useEventsHeader() {
  const ctx = useContext(EventsHeaderContext);
  if (!ctx) throw new Error('useEventsHeader requires EventsHeaderProvider');
  return ctx;
}
