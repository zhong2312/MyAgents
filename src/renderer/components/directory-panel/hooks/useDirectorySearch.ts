import { useCallback, useEffect, useRef, useState } from 'react';

import {
  refreshWorkspaceFileIndex,
  searchWorkspaceFiles,
  type FileSearchHit,
  type FolderSearchHit,
} from '@/api/searchClient';
import {
  activeTargetStillExists,
  defaultExpandedFilesForHits,
  mergeExpandedFilesAfterRefresh,
  normalizeFileSearchHits,
  normalizeFolderSearchHits,
  type ActiveSearchTarget,
} from '@/utils/workspaceSearchNavigation';

import { SEARCH_REFRESH_DELAY_MS } from '../constants';
import type { SearchResultContextMenuState } from '../types';
import { useDebounce } from './useDebounce';

export function useDirectorySearch(agentDir: string) {
  const [isSearchMode, setIsSearchMode] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [isRefreshingSearch, setIsRefreshingSearch] = useState(false);
  const [searchHits, setSearchHits] = useState<{
    folderResults: FolderSearchHit[];
    searchResults: FileSearchHit[];
  }>({ folderResults: [], searchResults: [] });
  const { folderResults, searchResults } = searchHits;
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const [activeSearchTarget, setActiveSearchTarget] =
    useState<ActiveSearchTarget | null>(null);
  const [searchContextMenu, setSearchContextMenu] =
    useState<SearchResultContextMenuState>(null);
  const [treeRevealRequest, setTreeRevealRequest] = useState<{
    id: number;
    path: string;
  } | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchRequestIdRef = useRef(0);
  const searchRefreshRef = useRef<{ workspace: string; promise: Promise<[number, number]> } | null>(null);
  const searchResultsRef = useRef<FileSearchHit[]>([]);
  const treeRevealRequestIdRef = useRef(0);
  const debouncedSearchQuery = useDebounce(searchQuery, 300);

  useEffect(
    () => () => {
      treeRevealRequestIdRef.current += 1;
    },
    [],
  );

  useEffect(() => {
    searchResultsRef.current = searchResults;
  }, [searchResults]);

  useEffect(() => {
    if (isSearchMode) {
      setTreeRevealRequest(null);
    }
  }, [isSearchMode]);

  const refreshSearchIndex = useCallback(() => {
    const current = searchRefreshRef.current;
    if (current?.workspace === agentDir) return current.promise;
    const entry = {
      workspace: agentDir,
      promise: refreshWorkspaceFileIndex(agentDir),
    };
    entry.promise = entry.promise.finally(() => {
      if (searchRefreshRef.current === entry) {
        searchRefreshRef.current = null;
      }
    });
    searchRefreshRef.current = entry;
    return entry.promise;
  }, [agentDir]);

  useEffect(() => {
    if (!isSearchMode) {
      searchRequestIdRef.current += 1;
      searchRefreshRef.current = null;
      setIsSearching(false);
      setIsRefreshingSearch(false);
      setActiveSearchTarget(null);
      setSearchContextMenu(null);
      return;
    }
    const query = debouncedSearchQuery.trim();
    if (query === "") {
      searchRequestIdRef.current += 1;
      setSearchHits({ folderResults: [], searchResults: [] });
      setIsSearching(false);
      setIsRefreshingSearch(false);
      setExpandedFiles(new Set());
      setActiveSearchTarget(null);
      setSearchContextMenu(null);
      return;
    }
    const requestId = searchRequestIdRef.current + 1;
    searchRequestIdRef.current = requestId;
    let cancelled = false;
    let refreshDelayTimer: ReturnType<typeof setTimeout> | null = null;
    let resolveRefreshDelay: (() => void) | null = null;
    const isCurrent = () => !cancelled && searchRequestIdRef.current === requestId;
    const waitForRefreshDelay = () =>
      new Promise<void>((resolve) => {
        resolveRefreshDelay = resolve;
        refreshDelayTimer = setTimeout(() => {
          refreshDelayTimer = null;
          resolveRefreshDelay = null;
          resolve();
        }, SEARCH_REFRESH_DELAY_MS);
      });
    const runSearch = async () => {
      setIsSearching(true);
      setIsRefreshingSearch(false);
      setSearchHits({ folderResults: [], searchResults: [] });
      setExpandedFiles(new Set());
      setActiveSearchTarget(null);
      setSearchContextMenu(null);
      try {
        const result = await searchWorkspaceFiles(query, agentDir);
        if (isCurrent()) {
          const hits = normalizeFileSearchHits(result.hits);
          setSearchHits({
            folderResults: normalizeFolderSearchHits(result.folderHits),
            searchResults: hits,
          });
          setExpandedFiles(defaultExpandedFilesForHits(hits));
          setActiveSearchTarget((prev) =>
            activeTargetStillExists(prev, hits) ? prev : null,
          );
        }
      } catch (err) {
        if (isCurrent()) {
          console.error("File search failed:", err);
          setSearchHits({ folderResults: [], searchResults: [] });
          setExpandedFiles(new Set());
        }
        return;
      } finally {
        if (isCurrent()) {
          setIsSearching(false);
        }
      }

      await waitForRefreshDelay();
      if (!isCurrent()) return;
      setIsRefreshingSearch(true);
      try {
        await refreshSearchIndex();
        if (!isCurrent()) return;
        const refreshed = await searchWorkspaceFiles(query, agentDir);
        if (isCurrent()) {
          const previousHits = searchResultsRef.current;
          const hits = normalizeFileSearchHits(refreshed.hits);
          setSearchHits({
            folderResults: normalizeFolderSearchHits(refreshed.folderHits),
            searchResults: hits,
          });
          setExpandedFiles((prev) =>
            mergeExpandedFilesAfterRefresh(
              prev,
              previousHits,
              hits,
            ),
          );
          setActiveSearchTarget((prev) =>
            activeTargetStillExists(prev, hits) ? prev : null,
          );
        }
      } catch (err) {
        if (isCurrent()) {
          console.error("File search refresh failed:", err);
        }
      } finally {
        if (isCurrent()) {
          setIsRefreshingSearch(false);
        }
      }
    };
    runSearch();
    return () => {
      cancelled = true;
      if (searchRequestIdRef.current === requestId) {
        searchRequestIdRef.current += 1;
      }
      if (refreshDelayTimer) {
        clearTimeout(refreshDelayTimer);
        refreshDelayTimer = null;
      }
      resolveRefreshDelay?.();
      resolveRefreshDelay = null;
    };
  }, [debouncedSearchQuery, agentDir, refreshSearchIndex, isSearchMode]);

  return {
    isSearchMode,
    setIsSearchMode,
    searchQuery,
    setSearchQuery,
    isSearching,
    isRefreshingSearch,
    folderResults,
    searchResults,
    expandedFiles,
    setExpandedFiles,
    activeSearchTarget,
    setActiveSearchTarget,
    searchContextMenu,
    setSearchContextMenu,
    treeRevealRequest,
    setTreeRevealRequest,
    searchInputRef,
    treeRevealRequestIdRef,
    debouncedSearchQuery,
  };
}
