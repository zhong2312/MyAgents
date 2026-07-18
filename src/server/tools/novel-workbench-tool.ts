import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import { dirname, join, resolve, sep } from "path";

import {
  bindNovelWorkbenchRuntime,
  getNovelWorkbenchContext,
  NOVEL_WORKBENCH_MCP_ID,
} from "../novel-workbench-context";

type CallToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

type ProposedChange = {
  id: string;
  targetPath: string;
  operation: "create" | "modify";
  summary: string;
  content: string;
};

const LIBRARY_ROOT = "world/setting-library";
const PROPOSAL_ROOT = `${LIBRARY_ROOT}/proposals`;
const TARGET_PATTERN =
  /^world\/setting-library\/(?:meta\.json|spatial-tree\.json|settings\.json|pages\/[a-z0-9-]+\/[a-z0-9-]+\.md|entries\/[a-z0-9-]+\/[a-z0-9-]+\.json)$/;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const MAX_CHANGE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

function result(value: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireWorkspace(): {
  workspace: string;
  context: NonNullable<ReturnType<typeof getNovelWorkbenchContext>>;
} {
  const context = getNovelWorkbenchContext();
  if (!context?.workspace) {
    throw new Error("小说工作台工具尚未绑定到项目工作区");
  }
  return { workspace: resolve(context.workspace), context };
}

function normalizeTargetPath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!TARGET_PATTERN.test(normalized)) {
    throw new Error(`不允许的世界架构目标路径：${value}`);
  }
  return normalized;
}

function workspaceFile(workspace: string, path: string): string {
  const absolute = resolve(workspace, ...path.split("/"));
  if (absolute !== workspace && !absolute.startsWith(`${workspace}${sep}`)) {
    throw new Error(`路径越出小说项目：${path}`);
  }
  return absolute;
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function parseJson(path: string, content: string, errors: string[]): unknown {
  try {
    return JSON.parse(content);
  } catch (error) {
    errors.push(`${path} 不是有效 JSON：${message(error)}`);
    return null;
  }
}

function arrayField(value: unknown, field: string): unknown[] | null {
  if (!value || typeof value !== "object") return null;
  const candidate = (value as Record<string, unknown>)[field];
  return Array.isArray(candidate) ? candidate : null;
}

async function validateChanges(
  changes: readonly ProposedChange[],
): Promise<string[]> {
  const { workspace } = requireWorkspace();
  const errors: string[] = [];
  if (changes.length === 0) return ["至少需要一个变更"];
  if (changes.length > 100) return ["单个提案最多包含 100 个变更"];

  const ids = new Set<string>();
  const targets = new Set<string>();
  const prospective = new Map<string, string>();
  let totalBytes = 0;
  for (const change of changes) {
    if (!ID_PATTERN.test(change.id) || ids.has(change.id)) {
      errors.push(`变更 id 非法或重复：${change.id}`);
    }
    ids.add(change.id);
    let targetPath: string;
    try {
      targetPath = normalizeTargetPath(change.targetPath);
    } catch (error) {
      errors.push(message(error));
      continue;
    }
    if (targets.has(targetPath)) errors.push(`目标路径重复：${targetPath}`);
    targets.add(targetPath);
    if (!change.summary.trim()) errors.push(`${change.id} 缺少变更摘要`);
    const bytes = Buffer.byteLength(change.content, "utf8");
    totalBytes += bytes;
    if (bytes > MAX_CHANGE_BYTES) errors.push(`${targetPath} 超过 2 MiB`);
    prospective.set(targetPath, change.content);
    const current = await readOptional(workspaceFile(workspace, targetPath));
    if (change.operation === "create" && current !== null) {
      errors.push(`create 目标已经存在：${targetPath}`);
    }
    if (change.operation === "modify" && current === null) {
      errors.push(`modify 目标不存在：${targetPath}`);
    }
    if (targetPath.endsWith(".json"))
      parseJson(targetPath, change.content, errors);
  }
  if (totalBytes > MAX_TOTAL_BYTES) errors.push("提案内容总量超过 8 MiB");
  if (errors.length > 0) return errors;

  const readProspectiveJson = async (path: string): Promise<unknown> => {
    const content =
      prospective.get(path) ??
      (await readOptional(workspaceFile(workspace, path)));
    if (content === null) {
      errors.push(`缺少正式设定文件：${path}`);
      return null;
    }
    return parseJson(path, content, errors);
  };
  const meta = await readProspectiveJson(`${LIBRARY_ROOT}/meta.json`);
  const tree = await readProspectiveJson(`${LIBRARY_ROOT}/spatial-tree.json`);
  const settings = await readProspectiveJson(`${LIBRARY_ROOT}/settings.json`);
  const levelTypes = arrayField(meta, "levelTypes");
  const templates = arrayField(meta, "settingTemplates");
  const profiles = arrayField(meta, "profiles");
  const nodes = arrayField(tree, "nodes");
  const settingItems = arrayField(settings, "settings");
  if (!levelTypes) errors.push("meta.json 缺少 levelTypes 数组");
  if (!templates) errors.push("meta.json 缺少 settingTemplates 数组");
  if (!profiles) errors.push("meta.json 缺少 profiles 数组");
  if (!nodes) errors.push("spatial-tree.json 缺少 nodes 数组");
  if (!settingItems) errors.push("settings.json 缺少 settings 数组");
  if (errors.length > 0) return errors;

  const idsOf = (items: unknown[], label: string): Set<string> => {
    const output = new Set<string>();
    for (const item of items) {
      const id =
        item && typeof item === "object"
          ? (item as Record<string, unknown>).id
          : null;
      if (typeof id !== "string" || !ID_PATTERN.test(id) || output.has(id)) {
        errors.push(`${label} 包含非法或重复 id：${String(id)}`);
      } else output.add(id);
    }
    return output;
  };
  const typeIds = idsOf(levelTypes!, "levelTypes");
  const templateIds = idsOf(templates!, "settingTemplates");
  const nodeIds = idsOf(nodes!, "nodes");
  const parentByNode = new Map<string, string | null>();
  for (const node of nodes!) {
    if (!node || typeof node !== "object") continue;
    const item = node as Record<string, unknown>;
    if (typeof item.id === "string") {
      parentByNode.set(
        item.id,
        typeof item.parentId === "string" ? item.parentId : null,
      );
    }
    if (typeof item.typeId !== "string" || !typeIds.has(item.typeId)) {
      errors.push(`空间节点 ${String(item.id)} 引用了不存在的类型`);
    }
    if (
      item.parentId !== null &&
      (typeof item.parentId !== "string" || !nodeIds.has(item.parentId))
    ) {
      errors.push(`空间节点 ${String(item.id)} 引用了不存在的父节点`);
    }
  }
  for (const nodeId of nodeIds) {
    const visited = new Set([nodeId]);
    let parentId = parentByNode.get(nodeId) ?? null;
    while (parentId !== null) {
      if (visited.has(parentId)) {
        errors.push(`空间树包含循环引用：${nodeId}`);
        break;
      }
      visited.add(parentId);
      parentId = parentByNode.get(parentId) ?? null;
    }
  }
  const profileTypeIds = new Set<string>();
  for (const profile of profiles!) {
    if (!profile || typeof profile !== "object") continue;
    const item = profile as Record<string, unknown>;
    if (
      typeof item.levelTypeId !== "string" ||
      !typeIds.has(item.levelTypeId)
    ) {
      errors.push(
        `模板关联引用了不存在的层级类型：${String(item.levelTypeId)}`,
      );
    }
    if (typeof item.levelTypeId === "string") {
      if (profileTypeIds.has(item.levelTypeId)) {
        errors.push(`层级类型 ${item.levelTypeId} 只能有一份模板关联`);
      }
      profileTypeIds.add(item.levelTypeId);
    }
    if (
      !Array.isArray(item.templateIds) ||
      item.templateIds.some(
        (id) => typeof id !== "string" || !templateIds.has(id),
      )
    ) {
      errors.push(`层级类型 ${String(item.levelTypeId)} 包含不存在的模板引用`);
    } else if (new Set(item.templateIds).size !== item.templateIds.length) {
      errors.push(`层级类型 ${String(item.levelTypeId)} 包含重复的模板引用`);
    }
  }
  const settingIds = new Set<string>();
  const materializedTemplates = new Set<string>();
  const referencedSettingFiles = new Set<string>();
  for (const setting of settingItems!) {
    if (!setting || typeof setting !== "object") continue;
    const item = setting as Record<string, unknown>;
    if (
      typeof item.id !== "string" ||
      !ID_PATTERN.test(item.id) ||
      settingIds.has(item.id)
    ) {
      errors.push(`settings 包含非法或重复 id：${String(item.id)}`);
    } else {
      settingIds.add(item.id);
    }
    if (typeof item.nodeId !== "string" || !nodeIds.has(item.nodeId)) {
      errors.push(`设定 ${String(item.id)} 引用了不存在的空间节点`);
    }
    if (
      item.templateId !== null &&
      (typeof item.templateId !== "string" || !templateIds.has(item.templateId))
    ) {
      errors.push(`设定 ${String(item.id)} 引用了不存在的模板`);
    }
    if (
      typeof item.nodeId === "string" &&
      typeof item.templateId === "string"
    ) {
      const identity = `${item.nodeId}:${item.templateId}`;
      if (materializedTemplates.has(identity)) {
        errors.push(
          `设定 ${String(item.id)} 与同节点的其他页面重复使用模板 ${item.templateId}`,
        );
      }
      materializedTemplates.add(identity);
    }
    for (const key of ["pagePath", "entriesPath"] as const) {
      if (typeof item[key] !== "string") {
        errors.push(`设定 ${String(item.id)} 缺少 ${key}`);
        continue;
      }
      let path: string;
      try {
        path = normalizeTargetPath(item[key]);
      } catch (error) {
        errors.push(message(error));
        continue;
      }
      referencedSettingFiles.add(path);
      if (
        !prospective.has(path) &&
        (await readOptional(workspaceFile(workspace, path))) === null
      ) {
        errors.push(`设定 ${String(item.id)} 引用了不存在的文件：${path}`);
      }
    }
  }
  const orphanProposalFiles = [...prospective.keys()].filter(
    (path) =>
      (path.startsWith(`${LIBRARY_ROOT}/pages/`) ||
        path.startsWith(`${LIBRARY_ROOT}/entries/`)) &&
      !referencedSettingFiles.has(path),
  );
  if (orphanProposalFiles.length > 0) {
    const preview = orphanProposalFiles.slice(0, 3).join("、");
    const remainder =
      orphanProposalFiles.length - Math.min(3, orphanProposalFiles.length);
    errors.push(
      `提案文件未被最终 settings.json 引用：${preview}${
        remainder > 0 ? `（另有 ${remainder} 个）` : ""
      }。请在同一提案中修改 settings.json，登记对应的 pagePath 和 entriesPath`,
    );
  }
  return errors;
}

async function getContextHandler(args: {
  paths?: string[];
}): Promise<CallToolResult> {
  try {
    const { workspace, context } = requireWorkspace();
    const paths = new Set([
      `${LIBRARY_ROOT}/meta.json`,
      `${LIBRARY_ROOT}/spatial-tree.json`,
      `${LIBRARY_ROOT}/settings.json`,
    ]);
    for (const requested of args.paths ?? [])
      paths.add(normalizeTargetPath(requested));
    if (paths.size > 30) throw new Error("单次最多读取 30 个设定文件");
    const files: Record<string, string | null> = {};
    for (const path of paths)
      files[path] = await readOptional(workspaceFile(workspace, path));
    return result({ mode: context.mode, files });
  } catch (error) {
    return result({ error: message(error) }, true);
  }
}

async function validateHandler(args: {
  changes: ProposedChange[];
}): Promise<CallToolResult> {
  try {
    const errors = await validateChanges(args.changes);
    return result({ valid: errors.length === 0, errors }, errors.length > 0);
  } catch (error) {
    return result({ valid: false, errors: [message(error)] }, true);
  }
}

async function submitHandler(args: {
  proposalId?: string;
  title: string;
  description?: string;
  changes: ProposedChange[];
}): Promise<CallToolResult> {
  let proposalDirectory = "";
  let createdProposalDirectory = false;
  try {
    const { workspace, context } = requireWorkspace();
    const errors = await validateChanges(args.changes);
    if (errors.length > 0) return result({ submitted: false, errors }, true);
    const proposalId =
      args.proposalId?.trim() || `proposal-${randomUUID().slice(0, 8)}`;
    if (!ID_PATTERN.test(proposalId))
      throw new Error("proposalId 只能使用小写字母、数字和连字符");
    const proposalsDirectory = workspaceFile(workspace, PROPOSAL_ROOT);
    proposalDirectory = workspaceFile(
      workspace,
      `${PROPOSAL_ROOT}/${proposalId}`,
    );
    await fs.mkdir(proposalsDirectory, { recursive: true });
    await fs.mkdir(proposalDirectory);
    createdProposalDirectory = true;

    const manifestChanges = [];
    for (const change of args.changes) {
      const targetPath = normalizeTargetPath(change.targetPath);
      const snapshotRelative = targetPath.slice(`${LIBRARY_ROOT}/`.length);
      const afterPath = join(
        proposalDirectory,
        "after",
        ...snapshotRelative.split("/"),
      );
      await fs.mkdir(dirname(afterPath), { recursive: true });
      await fs.writeFile(afterPath, change.content, {
        encoding: "utf8",
        flag: "wx",
      });
      if (change.operation === "modify") {
        const beforeContent = await fs.readFile(
          workspaceFile(workspace, targetPath),
          "utf8",
        );
        const beforePath = join(
          proposalDirectory,
          "before",
          ...snapshotRelative.split("/"),
        );
        await fs.mkdir(dirname(beforePath), { recursive: true });
        await fs.writeFile(beforePath, beforeContent, {
          encoding: "utf8",
          flag: "wx",
        });
      }
      manifestChanges.push({
        id: change.id,
        targetPath,
        operation: change.operation,
        summary: change.summary.trim(),
        status: "pending",
      });
    }
    const manifest = {
      schemaVersion: 1,
      proposalId,
      title: args.title.trim(),
      description: args.description?.trim() ?? "",
      createdAt: new Date().toISOString(),
      source: {
        kind: "agent",
        promptId: context.promptId,
        promptVersion: context.promptVersion,
      },
      changes: manifestChanges,
    };
    await fs.writeFile(
      join(proposalDirectory, "proposal.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    return result({
      submitted: true,
      proposalId,
      changeCount: manifestChanges.length,
      reviewAction: "请作者在小说工作台点击“审阅提案”进行逐项审批。",
    });
  } catch (error) {
    if (createdProposalDirectory) {
      await fs
        .rm(proposalDirectory, { recursive: true, force: true })
        .catch(() => {});
    }
    return result({ submitted: false, error: message(error) }, true);
  }
}

export async function createNovelWorkbenchServer() {
  const { createSdkMcpServer, tool } = await import(
    "@anthropic-ai/claude-agent-sdk"
  );
  const { z } = await import("zod/v4");
  const changeSchema = z.object({
    id: z.string().regex(ID_PATTERN),
    targetPath: z.string(),
    operation: z.enum(["create", "modify"]),
    summary: z.string().min(1),
    content: z.string(),
  });
  return createSdkMcpServer({
    name: NOVEL_WORKBENCH_MCP_ID,
    version: "1.0.0",
    tools: [
      tool(
        "novel_world_get_context",
        "读取小说工作台当前世界架构。默认返回 meta、空间树和设定索引；需要查看具体页面时传入受支持的项目相对路径。",
        { paths: z.array(z.string()).max(27).optional() },
        getContextHandler,
      ),
      tool(
        "novel_world_validate_changes",
        "校验世界架构变更的路径、JSON、层级引用、模板关联和设定文件闭合性。提交提案前必须调用。",
        { changes: z.array(changeSchema).min(1).max(100) },
        validateHandler,
      ),
      tool(
        "novel_world_submit_proposal",
        "提交待审批的世界架构提案。该工具只写 proposals 快照，不会修改正式设定；正式写入只能由作者在审批界面执行。",
        {
          proposalId: z.string().regex(ID_PATTERN).optional(),
          title: z.string().min(1),
          description: z.string().optional(),
          changes: z.array(changeSchema).min(1).max(100),
        },
        submitHandler,
      ),
    ],
  });
}

export function configureNovelWorkbench(
  _env: Record<string, string>,
  runtime: { sessionId: string; workspace?: string },
): void {
  bindNovelWorkbenchRuntime(runtime);
}
