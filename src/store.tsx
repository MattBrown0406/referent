import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Referent, Referral } from './types';
import { seedReferents, seedReferrals } from './data';

const STORAGE_KEY = 'referral-tracker-v2';

interface StoreState {
  referents: Referent[];
  referrals: Referral[];
  loaded: boolean;
  addReferent: (r: Omit<Referent, 'id' | 'createdAt'>) => Referent;
  updateReferent: (id: string, patch: Partial<Referent>) => void;
  deleteReferent: (id: string) => void;
  addReferral: (f: Omit<Referral, 'id'>) => void;
  deleteReferral: (id: string) => void;
  referralStats: (referentId: string) => { inbound: number; outbound: number; net: number };
}

const StoreContext = createContext<StoreState | null>(null);

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function StoreProvider({ children }: { children: React.ReactNode }) {
  const [referents, setReferents] = useState<Referent[]>([]);
  const [referrals, setReferrals] = useState<Referral[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          setReferents(parsed.referents ?? seedReferents);
          setReferrals(parsed.referrals ?? seedReferrals);
        } else {
          setReferents(seedReferents);
          setReferrals(seedReferrals);
        }
      } catch {
        setReferents(seedReferents);
        setReferrals(seedReferrals);
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  useEffect(() => {
    if (!loaded) return;
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ referents, referrals })).catch(() => {});
  }, [referents, referrals, loaded]);

  const value = useMemo<StoreState>(
    () => ({
      referents,
      referrals,
      loaded,
      addReferent: (r) => {
        const created: Referent = { ...r, id: newId(), createdAt: new Date().toISOString() };
        setReferents((prev) => [created, ...prev]);
        return created;
      },
      updateReferent: (id, patch) =>
        setReferents((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r))),
      deleteReferent: (id) => {
        setReferents((prev) => prev.filter((r) => r.id !== id));
        setReferrals((prev) => prev.filter((f) => f.referentId !== id));
      },
      addReferral: (f) => setReferrals((prev) => [{ ...f, id: newId() }, ...prev]),
      deleteReferral: (id) => setReferrals((prev) => prev.filter((f) => f.id !== id)),
      referralStats: (referentId) => {
        let inbound = 0;
        let outbound = 0;
        for (const f of referrals) {
          if (f.referentId !== referentId) continue;
          if (f.direction === 'inbound') inbound++;
          else outbound++;
        }
        return { inbound, outbound, net: inbound - outbound };
      },
    }),
    [referents, referrals, loaded]
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore must be used within StoreProvider');
  return ctx;
}
