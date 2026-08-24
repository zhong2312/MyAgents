import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDirectorySearch } from './useDirectorySearch';

const searchMocks = vi.hoisted(() => ({
  searchWorkspaceFiles: vi.fn(),
  refreshWorkspaceFileIndex: vi.fn(),
}));

vi.mock('@/api/searchClient', () => ({
  searchWorkspaceFiles: searchMocks.searchWorkspaceFiles,
  refreshWorkspaceFileIndex: searchMocks.refreshWorkspaceFileIndex,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function SearchHarness({ workspace = '/workspace' }: { workspace?: string }) {
  const search = useDirectorySearch(workspace);

  return (
    <div>
      <button onClick={() => search.setIsSearchMode(true)}>open</button>
      <button onClick={() => search.setIsSearchMode(false)}>close</button>
      <input
        aria-label="query"
        value={search.searchQuery}
        onChange={(event) => search.setSearchQuery(event.target.value)}
      />
      <output aria-label="loading">{String(search.isSearching)}</output>
      <output aria-label="refreshing">{String(search.isRefreshingSearch)}</output>
      <output aria-label="folders">{search.folderResults.map((hit) => hit.path).join(',')}</output>
      <output aria-label="hits">{search.searchResults.map((hit) => hit.path).join(',')}</output>
      <output aria-label="expanded">{Array.from(search.expandedFiles).join(',')}</output>
      <button onClick={() => search.setExpandedFiles(new Set(['docs/old.md']))}>expand old</button>
    </div>
  );
}

describe('useDirectorySearch', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    searchMocks.searchWorkspaceFiles.mockReset();
    searchMocks.refreshWorkspaceFileIndex.mockReset();
    searchMocks.searchWorkspaceFiles
      .mockResolvedValueOnce({
        folderHits: [{ path: 'docs', name: 'docs' }],
        hits: [{ path: 'docs/old.md', name: 'old.md', matchCount: 1, matches: [{ lineNumber: 3, lineContent: 'old', highlights: [] }] }],
      })
      .mockResolvedValueOnce({
        folderHits: [{ path: 'docs-new', name: 'docs-new' }],
        hits: [
          { path: 'docs/old.md', name: 'old.md', matchCount: 1, matches: [{ lineNumber: 3, lineContent: 'old', highlights: [] }] },
          { path: 'docs/new.md', name: 'new.md', matchCount: 1, matches: [{ lineNumber: 4, lineContent: 'new', highlights: [] }] },
        ],
      });
    searchMocks.refreshWorkspaceFileIndex.mockResolvedValue([0, 0]);
  });

  it('searches after debounce and refreshes stale results when the index changes', async () => {
    render(<SearchHarness />);

    fireEvent.click(screen.getByText('open'));
    fireEvent.change(screen.getByLabelText('query'), { target: { value: 'note' } });

    await waitFor(() => expect(screen.getByLabelText('hits')).toHaveTextContent('docs/old.md'));
    expect(screen.getByLabelText('folders')).toHaveTextContent('docs');
    expect(screen.getByLabelText('expanded')).toBeEmptyDOMElement();
    expect(searchMocks.searchWorkspaceFiles).toHaveBeenCalledWith('note', '/workspace');

    fireEvent.click(screen.getByText('expand old'));

    await waitFor(() => expect(screen.getByLabelText('folders')).toHaveTextContent('docs-new'));
    expect(screen.getByLabelText('hits')).toHaveTextContent('docs/old.md,docs/new.md');
    expect(screen.getByLabelText('expanded')).toHaveTextContent('docs/old.md');
    expect(searchMocks.refreshWorkspaceFileIndex).toHaveBeenCalledWith('/workspace');
    expect(searchMocks.searchWorkspaceFiles).toHaveBeenCalledTimes(2);
  });

  it('cancels the pending refresh delay when unmounted', async () => {
    vi.useFakeTimers();
    searchMocks.searchWorkspaceFiles.mockReset().mockResolvedValue({
      folderHits: [],
      hits: [{ path: 'docs/old.md', name: 'old.md', matchCount: 1, matches: [{ lineNumber: 3, lineContent: 'old', highlights: [] }] }],
    });
    const { unmount } = render(<SearchHarness />);

    fireEvent.click(screen.getByText('open'));
    fireEvent.change(screen.getByLabelText('query'), { target: { value: 'note' } });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(screen.getByLabelText('hits')).toHaveTextContent('docs/old.md');
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      await vi.runOnlyPendingTimersAsync();
    });

    expect(searchMocks.refreshWorkspaceFileIndex).not.toHaveBeenCalled();
  });

  it('resets manual expansion after leaving and re-entering search', async () => {
    searchMocks.searchWorkspaceFiles.mockReset().mockResolvedValue({
      folderHits: [],
      hits: [{
        path: 'docs/old.md',
        name: 'old.md',
        matchCount: 3,
        matches: [
          { lineNumber: 1, lineContent: 'one', highlights: [] },
          { lineNumber: 2, lineContent: 'two', highlights: [] },
          { lineNumber: 3, lineContent: 'three', highlights: [] },
        ],
      }],
    });
    render(<SearchHarness />);

    fireEvent.click(screen.getByText('open'));
    fireEvent.change(screen.getByLabelText('query'), { target: { value: 'note' } });
    await waitFor(() => expect(screen.getByLabelText('hits')).toHaveTextContent('docs/old.md'));
    fireEvent.click(screen.getByText('expand old'));
    expect(screen.getByLabelText('expanded')).toHaveTextContent('docs/old.md');

    fireEvent.click(screen.getByText('close'));
    fireEvent.click(screen.getByText('open'));

    await waitFor(() => expect(screen.getByLabelText('expanded')).toBeEmptyDOMElement());
    expect(screen.getByLabelText('query')).toHaveValue('note');
  });

  it('does not let a slower previous query replace the latest atomic response', async () => {
    vi.useFakeTimers();
    const oldSearch = deferred<{ folderHits: { path: string; name: string }[]; hits: never[] }>();
    const newSearch = deferred<{ folderHits: { path: string; name: string }[]; hits: never[] }>();
    searchMocks.searchWorkspaceFiles.mockReset().mockImplementation((query: string) => (
      query === 'old' ? oldSearch.promise : newSearch.promise
    ));
    render(<SearchHarness />);

    fireEvent.click(screen.getByText('open'));
    fireEvent.change(screen.getByLabelText('query'), { target: { value: 'old' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    fireEvent.change(screen.getByLabelText('query'), { target: { value: 'new' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });

    await act(async () => {
      newSearch.resolve({ folderHits: [{ path: 'new-folder', name: 'new-folder' }], hits: [] });
      await newSearch.promise;
    });
    expect(screen.getByLabelText('folders')).toHaveTextContent('new-folder');

    await act(async () => {
      oldSearch.resolve({ folderHits: [{ path: 'old-folder', name: 'old-folder' }], hits: [] });
      await oldSearch.promise;
    });
    expect(screen.getByLabelText('folders')).toHaveTextContent('new-folder');
    expect(screen.getByLabelText('folders')).not.toHaveTextContent('old-folder');
  });

  it('does not let a previous workspace response replace the current workspace', async () => {
    vi.useFakeTimers();
    const oldWorkspace = deferred<{ folderHits: { path: string; name: string }[]; hits: never[] }>();
    const newWorkspace = deferred<{ folderHits: { path: string; name: string }[]; hits: never[] }>();
    searchMocks.searchWorkspaceFiles.mockReset().mockImplementation((_: string, workspace: string) => (
      workspace === '/workspace' ? oldWorkspace.promise : newWorkspace.promise
    ));
    const { rerender } = render(<SearchHarness />);

    fireEvent.click(screen.getByText('open'));
    fireEvent.change(screen.getByLabelText('query'), { target: { value: 'note' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    rerender(<SearchHarness workspace="/other" />);

    await act(async () => {
      newWorkspace.resolve({ folderHits: [{ path: 'other-folder', name: 'other-folder' }], hits: [] });
      await newWorkspace.promise;
    });
    expect(screen.getByLabelText('folders')).toHaveTextContent('other-folder');

    await act(async () => {
      oldWorkspace.resolve({ folderHits: [{ path: 'old-folder', name: 'old-folder' }], hits: [] });
      await oldWorkspace.promise;
    });
    expect(screen.getByLabelText('folders')).toHaveTextContent('other-folder');
    expect(screen.getByLabelText('folders')).not.toHaveTextContent('old-folder');
  });
});
