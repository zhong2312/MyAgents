import { createHash, randomUUID } from "crypto";
import { promises as fs } from "fs";
import { dirname, join } from "path";

import { withFileLock } from "./utils/file-lock";

export type NovelWorkbenchDraftDomain =
  | "world"
  | "characters"
  | "items"
  | "factions"
  | "narrative"
  | "cultivation";

export interface NovelWorkbenchDraftSource {
  readonly promptId: string;
  readonly promptVersion: string;
  readonly sessionId: string;
}

export interface NovelWorkbenchDraftValidation {
  readonly revision: number;
  readonly contentHash: string;
  readonly token: string;
  readonly validatedAt: string;
}

export interface NovelWorkbenchDraft<T> {
  readonly schemaVersion: 1;
  readonly domain: NovelWorkbenchDraftDomain;
  readonly draftId: string;
  readonly source: NovelWorkbenchDraftSource;
  readonly payload: T;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly validation: NovelWorkbenchDraftValidation | null;
  readonly submittedProposalId: string | null;
}

const DRAFT_ROOTS: Readonly<Record<NovelWorkbenchDraftDomain, string>> = {
  world: "world/setting-library/drafts",
  characters: "characters/drafts",
  items: "world/items/drafts",
  factions: "world/factions/drafts",
  narrative: "narrative/drafts",
  cultivation: "world/cultivation-drafts",
};

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

function assertId(value: string, label: string): void {
  if (!ID_PATTERN.test(value)) {
    throw new Error(`${label} 只能使用小写字母、数字和连字符`);
  }
}

function draftPath(
  workspace: string,
  domain: NovelWorkbenchDraftDomain,
  draftId: string,
): string {
  assertId(draftId, "draftId");
  return join(workspace, ...DRAFT_ROOTS[domain].split("/"), draftId, "draft.json");
}

function serialize<T>(draft: NovelWorkbenchDraft<T>): string {
  return `${JSON.stringify(draft, null, 2)}\n`;
}

function parse<T>(
  value: unknown,
  domain: NovelWorkbenchDraftDomain,
): NovelWorkbenchDraft<T> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("AI 草稿格式错误");
  }
  const draft = value as Record<string, unknown>;
  if (
    draft.schemaVersion !== 1 ||
    draft.domain !== domain ||
    typeof draft.draftId !== "string" ||
    typeof draft.revision !== "number" ||
    typeof draft.createdAt !== "string" ||
    typeof draft.updatedAt !== "string" ||
    !draft.source ||
    typeof draft.source !== "object" ||
    Array.isArray(draft.source)
  ) {
    throw new Error("AI 草稿缺少必填字段");
  }
  assertId(draft.draftId, "draftId");
  const source = draft.source as Record<string, unknown>;
  if (
    typeof source.promptId !== "string" ||
    typeof source.promptVersion !== "string" ||
    typeof source.sessionId !== "string"
  ) {
    throw new Error("AI 草稿来源信息无效");
  }
  const validation = draft.validation;
  if (
    validation !== null &&
    (!validation ||
      typeof validation !== "object" ||
      typeof (validation as Record<string, unknown>).revision !== "number" ||
      typeof (validation as Record<string, unknown>).contentHash !== "string" ||
      typeof (validation as Record<string, unknown>).token !== "string" ||
      typeof (validation as Record<string, unknown>).validatedAt !== "string")
  ) {
    throw new Error("AI 草稿校验回执无效");
  }
  if (
    draft.submittedProposalId !== null &&
    typeof draft.submittedProposalId !== "string"
  ) {
    throw new Error("AI 草稿提交状态无效");
  }
  return draft as unknown as NovelWorkbenchDraft<T>;
}

async function write<T>(
  workspace: string,
  draft: NovelWorkbenchDraft<T>,
): Promise<void> {
  const path = draftPath(workspace, draft.domain, draft.draftId);
  await fs.mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await fs.writeFile(temporary, serialize(draft), "utf8");
  await fs.rename(temporary, path);
}

async function withDraftLock<T>(
  workspace: string,
  domain: NovelWorkbenchDraftDomain,
  draftId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const path = draftPath(workspace, domain, draftId);
  await fs.mkdir(dirname(path), { recursive: true });
  return withFileLock({ lockPath: `${path}.lock` }, operation);
}

export async function loadNovelWorkbenchDraft<T>(
  workspace: string,
  domain: NovelWorkbenchDraftDomain,
  draftId: string,
): Promise<NovelWorkbenchDraft<T>> {
  const content = await fs.readFile(draftPath(workspace, domain, draftId), "utf8");
  return parse<T>(JSON.parse(content), domain);
}

export async function createNovelWorkbenchDraft<T>(
  workspace: string,
  domain: NovelWorkbenchDraftDomain,
  source: NovelWorkbenchDraftSource,
  payload: T,
  draftId = `draft-${domain}-${randomUUID().slice(0, 8)}`,
): Promise<NovelWorkbenchDraft<T>> {
  assertId(draftId, "draftId");
  return withDraftLock(workspace, domain, draftId, async () => {
    try {
      await fs.access(draftPath(workspace, domain, draftId));
      throw new Error(`AI 草稿已存在：${draftId}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const now = new Date().toISOString();
    const draft: NovelWorkbenchDraft<T> = {
      schemaVersion: 1,
      domain,
      draftId,
      source,
      payload,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      validation: null,
      submittedProposalId: null,
    };
    await write(workspace, draft);
    return draft;
  });
}

export async function updateNovelWorkbenchDraft<T>(
  workspace: string,
  domain: NovelWorkbenchDraftDomain,
  draftId: string,
  update: (payload: T) => T | Promise<T>,
): Promise<NovelWorkbenchDraft<T>> {
  return withDraftLock(workspace, domain, draftId, async () => {
    const current = await loadNovelWorkbenchDraft<T>(workspace, domain, draftId);
    if (current.submittedProposalId) {
      throw new Error("该草稿已经提交；如需继续设计，请创建新草稿");
    }
    const next: NovelWorkbenchDraft<T> = {
      ...current,
      payload: await update(current.payload),
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
      validation: null,
    };
    await write(workspace, next);
    return next;
  });
}

export function hashNovelWorkbenchDraftPayload(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export async function saveNovelWorkbenchDraftValidation<T>(
  workspace: string,
  draft: NovelWorkbenchDraft<T>,
  contentHash: string,
): Promise<NovelWorkbenchDraft<T>> {
  return withDraftLock(workspace, draft.domain, draft.draftId, async () => {
    const current = await loadNovelWorkbenchDraft<T>(workspace, draft.domain, draft.draftId);
    if (
      current.revision !== draft.revision ||
      current.updatedAt !== draft.updatedAt ||
      current.submittedProposalId
    ) {
      throw new Error("草稿在校验期间发生变化，请重新校验");
    }
    const next: NovelWorkbenchDraft<T> = {
      ...current,
      validation: {
        revision: current.revision,
        contentHash,
        token: createHash("sha256")
          .update(`${current.draftId}:${current.revision}:${contentHash}:${randomUUID()}`)
          .digest("hex"),
        validatedAt: new Date().toISOString(),
      },
    };
    await write(workspace, next);
    return next;
  });
}

export async function markNovelWorkbenchDraftSubmitted<T>(
  workspace: string,
  draft: NovelWorkbenchDraft<T>,
  proposalId: string,
): Promise<NovelWorkbenchDraft<T>> {
  return withDraftLock(workspace, draft.domain, draft.draftId, async () => {
    const current = await loadNovelWorkbenchDraft<T>(workspace, draft.domain, draft.draftId);
    if (current.submittedProposalId === proposalId) return current;
    if (
      current.revision !== draft.revision ||
      current.validation?.token !== draft.validation?.token ||
      current.submittedProposalId
    ) {
      throw new Error("草稿在提交期间发生变化，请重新读取草稿状态");
    }
    const next: NovelWorkbenchDraft<T> = { ...current, submittedProposalId: proposalId };
    await write(workspace, next);
    return next;
  });
}

export function summarizeNovelWorkbenchDraft<T>(draft: NovelWorkbenchDraft<T>) {
  return {
    draftId: draft.draftId,
    domain: draft.domain,
    revision: draft.revision,
    validated:
      draft.validation?.revision === draft.revision
        ? { token: draft.validation.token, validatedAt: draft.validation.validatedAt }
        : null,
    submittedProposalId: draft.submittedProposalId,
    updatedAt: draft.updatedAt,
    payload: draft.payload,
  };
}
