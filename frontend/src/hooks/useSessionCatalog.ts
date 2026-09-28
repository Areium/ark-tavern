import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from './useApi';
import type { PlotInfo, WorldBookSummary } from '../types';
import type { CharacterDoc } from '../utils/characterCatalog';

export interface SessionCatalog {
  plots: PlotInfo[];
  books: WorldBookSummary[];
  characters: CharacterDoc[];
  loading: boolean;
  error: string;
  reload: () => Promise<void>;
}

/** One catalog per mounted hall, shared with its wizard; no cross-page stale cache. */
export function useSessionCatalog(): SessionCatalog {
  const api = useApi();
  const [state, setState] = useState<Omit<SessionCatalog, 'reload'>>({
    plots: [], books: [], characters: [], loading: true, error: '',
  });
  const mounted = useRef(false);
  const inFlight = useRef<Promise<void> | null>(null);
  const reload = useCallback(() => {
    if (inFlight.current) return inFlight.current;
    setState(previous => ({ ...previous, loading: true, error: '' }));
    const request = Promise.allSettled([api.listPlots(), api.listWorldbooks(), api.getCharacters()])
      .then(([plots, books, characters]) => {
        if (!mounted.current) return;
        const failures = [plots, books, characters].flatMap((result, index) =>
          result.status === 'rejected' ? [['剧情', '世界书', '角色'][index]] : []);
        setState(previous => ({
          plots: plots.status === 'fulfilled' ? plots.value || [] : previous.plots,
          books: books.status === 'fulfilled' ? (books.value?.books || []).filter(
            (book: WorldBookSummary) => book.book_type !== 'reference' && book.enabled) : previous.books,
          characters: characters.status === 'fulfilled' ? characters.value || [] : previous.characters,
          loading: false,
          error: failures.length ? `${failures.join('、')}目录未能加载，请重试。已填写的选项会保留。` : '',
        }));
      }).finally(() => { inFlight.current = null; });
    inFlight.current = request;
    return request;
  }, [api]);
  useEffect(() => {
    mounted.current = true;
    void reload();
    return () => { mounted.current = false; };
  }, [reload]);
  return { ...state, reload };
}
