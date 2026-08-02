import {
  orderManuscriptChapters,
  type ManuscriptDirectory,
  type ManuscriptDirectoryKind,
} from "./projectSchema";
import type { LoadedNovelProject } from "./repository";

const DIRECTORY_HEADING_LEVEL: Record<ManuscriptDirectoryKind, number> = {
  volume: 2,
  part: 3,
  folder: 4,
};

function directoryChain(
  directories: ReadonlyMap<string, ManuscriptDirectory>,
  directoryId: string | null,
): readonly ManuscriptDirectory[] {
  const chain: ManuscriptDirectory[] = [];
  let current = directoryId ? directories.get(directoryId) : undefined;
  while (current) {
    chain.unshift(current);
    current = current.parentId
      ? directories.get(current.parentId)
      : undefined;
  }
  return chain;
}

/** 按目录树顺序拼接整稿 Markdown（卷/篇/组标题 + 章节标题 + 正文）。 */
export function buildManuscriptExportMarkdown(
  project: LoadedNovelProject,
): string {
  const lines: string[] = [`# ${project.metadata.title}`, ""];
  const directories = new Map(
    project.chapterIndex.directories.map((directory) => [
      directory.id,
      directory,
    ]),
  );
  let lastDirectoryChainKey = "\u0000";
  for (const chapter of orderManuscriptChapters(
    project.chapterIndex.directories,
    project.chapters,
  )) {
    const chain = directoryChain(directories, chapter.directoryId);
    const chainKey = chain.map((directory) => directory.id).join("/");
    if (chainKey !== lastDirectoryChainKey) {
      for (const directory of chain) {
        lines.push(
          `${"#".repeat(DIRECTORY_HEADING_LEVEL[directory.kind])} ${directory.title}`,
          "",
        );
      }
      lastDirectoryChainKey = chainKey;
    }
    lines.push(`## 第 ${chapter.displayNumber} 章 ${chapter.title}`, "");
    const content = chapter.content.trim();
    if (content) {
      lines.push(content, "");
    }
  }
  return `${lines.join("\n").trim()}\n`;
}

const INVALID_FILE_NAME_CHARS = /[\\/:*?"<>|]/u;

/** 去除文件名中的非法字符与控制字符。 */
export function sanitizeExportFileName(value: string): string {
  const cleaned = value
    .split("")
    .filter((character) => {
      if (INVALID_FILE_NAME_CHARS.test(character)) return false;
      return character.charCodeAt(0) >= 0x20;
    })
    .join("")
    .trim();
  return cleaned || "未命名";
}

/** 通过 Blob 下载文本文件（导出到系统下载目录）。 */
export function downloadTextFile(
  fileName: string,
  content: string,
  mime = "text/markdown;charset=utf-8",
): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  // 延迟释放：同一 tick 内 revoke 可能与引擎的 blob 拉取竞争，导致 0 字节文件。
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}