import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { Workspace } from "./db";
import { createWorkspace, deleteWorkspace as dbDeleteWorkspace, listWorkspaces } from "./db";
import type { LanguageCode } from "./languages";

type WorkspaceContextValue = {
  loading: boolean;
  workspaces: Workspace[];
  active: Workspace | null;
  setActive: (id: number) => void;
  addWorkspace: (input: {
    targetLang: LanguageCode;
    nativeLang: LanguageCode;
    name?: string;
  }) => Promise<Workspace>;
  /** Delete a workspace and everything that hangs off it (cascade). If
   *  the deleted workspace was active, falls back to the first remaining
   *  workspace (or null if none left). */
  deleteWorkspace: (id: number) => Promise<void>;
};

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

const ACTIVE_ID_KEY = "polyglot.activeWorkspaceId";

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeId, setActiveId] = useState<number | null>(() => {
    const raw = localStorage.getItem(ACTIVE_ID_KEY);
    return raw ? Number(raw) : null;
  });

  useEffect(() => {
    let cancelled = false;
    listWorkspaces()
      .then((list) => {
        if (cancelled) return;
        setWorkspaces(list);
        setActiveId((current) => {
          if (current && list.some((w) => w.id === current)) return current;
          return list[0]?.id ?? null;
        });
      })
      .catch((err) => {
        console.error("Failed to load workspaces", err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (activeId == null) localStorage.removeItem(ACTIVE_ID_KEY);
    else localStorage.setItem(ACTIVE_ID_KEY, String(activeId));
  }, [activeId]);

  const active = workspaces.find((w) => w.id === activeId) ?? null;

  async function addWorkspace(input: {
    targetLang: LanguageCode;
    nativeLang: LanguageCode;
    name?: string;
  }) {
    const ws = await createWorkspace(input);
    setWorkspaces((prev) => [...prev, ws]);
    setActiveId(ws.id);
    return ws;
  }

  function setActive(id: number) {
    setActiveId(id);
  }

  async function deleteWorkspace(id: number) {
    await dbDeleteWorkspace(id);
    setWorkspaces((prev) => {
      const next = prev.filter((w) => w.id !== id);
      // If we just deleted the active one, jump to the first remaining
      // workspace (or clear active so the onboarding flow re-opens).
      setActiveId((current) => {
        if (current !== id) return current;
        return next[0]?.id ?? null;
      });
      return next;
    });
  }

  return (
    <WorkspaceContext.Provider
      value={{ loading, workspaces, active, setActive, addWorkspace, deleteWorkspace }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx)
    throw new Error("useWorkspace must be used inside <WorkspaceProvider />");
  return ctx;
}
