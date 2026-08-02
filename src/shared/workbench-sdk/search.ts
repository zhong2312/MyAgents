/**
 * 工作区搜索能力（Workbench API 1.8）。
 *
 * 宿主在 Tauri 桌面端提供基于 Tantivy 的工作区文件全文搜索（复用
 * `specs/tech_docs/search_architecture.md` 的 Rust SearchEngine）；浏览器开发
 * 模式不提供该能力，`isAvailable` 为 false，工作台应降级为领域索引并提示
 * 「正文全文搜索仅桌面模式可用」。
 *
 * 工作台不得直接导入宿主 `searchClient`；只能通过本能力发起搜索。
 */

/** 文件内单行匹配（含高亮区间）。 */
export interface WorkbenchSearchMatchLine {
  readonly lineNumber: number;
  readonly lineContent: string;
  /** Highlight positions within lineContent: [[start, end], ...] */
  readonly highlights: readonly (readonly [number, number])[];
}

/** 工作区文件命中。 */
export interface WorkbenchFileSearchHit {
  readonly path: string;
  readonly name: string;
  readonly matchCount: number;
  readonly matches: readonly WorkbenchSearchMatchLine[];
}

/** 工作区文件搜索结果。 */
export interface WorkbenchFileSearchResult {
  readonly hits: readonly WorkbenchFileSearchHit[];
  readonly totalFiles: number;
  readonly totalMatches: number;
  readonly queryTimeMs: number;
}

/** 工作区全文搜索能力。 */
export interface WorkbenchSearch {
  readonly isAvailable: boolean;
  /**
   * 在工作区根目录内搜索文件名与内容。
   * @param query 查询词（空串返回空结果）
   * @param limit 最大命中文件数
   * @param maxMatchesPerFile 单文件最多返回的匹配行数
   */
  searchFiles(
    query: string,
    limit?: number,
    maxMatchesPerFile?: number,
  ): Promise<WorkbenchFileSearchResult>;
  /**
   * 显式刷新工作区索引（stale-while-revalidate 用）。
   * 返回 [totalFiles, changedFiles]。
   */
  refreshIndex(): Promise<readonly [number, number]>;
  /** 硬重置索引（schema 迁移、损坏恢复用）。 */
  invalidateIndex(): Promise<void>;
}
