/**
 * 小说领域投影能力（Workbench API 1.10）。
 *
 * Tauri 桌面端以 rusqlite 维护可删除、可重建的 SQLite 派生投影；Markdown
 * 与 JSON 仍是唯一事实源。浏览器开发模式下 `isAvailable` 为 false，工作台
 * 必须直接读取事实源。投影不得成为打开项目或编辑事实源的前置条件。
 */

/** 可定位的领域实体投影行。 */
export interface WorkbenchProjectionEntity {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly sourcePath: string;
  readonly aliases: readonly string[];
  readonly summary: string;
  readonly updatedAt: string;
}

/** 领域实体之间的有向引用投影行。 */
export interface WorkbenchProjectionRef {
  readonly fromKind: string;
  readonly fromId: string;
  readonly toKind: string;
  readonly toId: string;
  readonly field: string;
}

/** 工作区的可丢弃领域投影查询能力。 */
export interface WorkbenchProjection {
  readonly isAvailable: boolean;
  listEntities(kind?: string): Promise<readonly WorkbenchProjectionEntity[]>;
  inboundRefs(kind: string, id: string): Promise<readonly WorkbenchProjectionRef[]>;
  rebuild(): Promise<readonly [number, number]>;
}
