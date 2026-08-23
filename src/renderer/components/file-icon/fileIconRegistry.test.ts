import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { FILE_ICON_ASSETS, SYMBOLS_UPSTREAM } from "./fileIconAssets";
import {
  CATEGORY_EXTENSION_RULES,
  COMPOUND_EXTENSION_RULES,
  DEDICATED_EXTENSION_RULES,
  FILENAME_RULES,
  resolveFileIconDescriptor,
  type ExtensionRule,
} from "./fileIconRegistry";

describe("resolveFileIconDescriptor", () => {
  it.each([
    [{ name: "src", nodeKind: "directory" as const }, "folder", "node-kind"],
    [
      { name: "src", nodeKind: "directory" as const, expanded: true },
      "folder-open",
      "node-kind",
    ],
    [{ name: "README.md" }, "markdown", "filename"],
    [{ name: "/repo/ReadMe.MD" }, "markdown", "filename"],
    [{ name: "LICENSE.txt" }, "license", "filename"],
    [{ name: ".env.local" }, "config", "filename"],
    [{ name: "types.d.ts" }, "declaration", "compound-extension"],
    [{ name: "backup.tar.gz" }, "archive", "compound-extension"],
    [{ name: "REPORT.PDF" }, "pdf", "extension"],
    [{ name: "notes.docx" }, "word", "extension"],
    [{ name: "notes.wps" }, "word", "extension"],
    [{ name: "ledger.xlsx" }, "spreadsheet", "extension"],
    [{ name: "ledger.et" }, "spreadsheet", "extension"],
    [{ name: "pitch.pptx" }, "presentation", "extension"],
    [{ name: "pitch.dps" }, "presentation", "extension"],
    [{ name: "component.tsx" }, "react", "extension"],
    [{ name: "photo.avif" }, "image", "category"],
    [{ name: "archive.unknown" }, "file-generic", "fallback"],
    [{ name: ".unknown" }, "file-generic", "fallback"],
    [{ name: "Makefile" }, "config", "filename"],
    [{ name: "C:\\repo\\src\\main.rs" }, "rust", "extension"],
  ])("resolves %o to %s through %s", (input, iconId, matchedBy) => {
    expect(resolveFileIconDescriptor(input)).toMatchObject({
      iconId,
      matchedBy,
    });
  });

  it("always returns a concrete asset", () => {
    const inputs = [
      "",
      "file",
      ".gitignore",
      "notes.wps",
      "table.et",
      "deck.dps",
      "model.glb",
    ];

    for (const name of inputs) {
      const descriptor = resolveFileIconDescriptor({ name });
      expect(FILE_ICON_ASSETS[descriptor.iconId].src).toBeTruthy();
    }
  });
});

function flattenExtensions(rules: readonly ExtensionRule[]): string[] {
  return rules.flatMap((rule) => [...rule.extensions]);
}

function collectSvgPaths(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectSvgPaths(path);
    return entry.isFile() && entry.name.endsWith(".svg") ? [path] : [];
  });
}

describe("file icon registry contract", () => {
  it("pins the reviewed Symbols upstream revision", () => {
    expect(SYMBOLS_UPSTREAM).toEqual({
      name: "Symbols",
      version: "0.0.25",
      commit: "296ef1b62287fb2315cb5651e552e09e8c8e1de8",
      repository: "https://github.com/miguelsolorio/symbols",
      license: "MIT",
    });
  });

  it.each([
    ["compound", COMPOUND_EXTENSION_RULES],
    ["dedicated", DEDICATED_EXTENSION_RULES],
    ["category", CATEGORY_EXTENSION_RULES],
  ] as const)("has no duplicate %s extensions", (_label, rules) => {
    const values = flattenExtensions(rules).map((value) => value.toLowerCase());
    expect(new Set(values).size).toBe(values.length);
  });

  it("has no duplicate normalized exact filenames", () => {
    const names = FILENAME_RULES.flatMap((rule) =>
      rule.kind === "exact" ? rule.names.map((name) => name.toLowerCase()) : [],
    );

    expect(new Set(names).size).toBe(names.length);
  });

  it("does not shadow category extensions with dedicated rules", () => {
    const dedicated = new Set(flattenExtensions(DEDICATED_EXTENSION_RULES));
    expect(
      flattenExtensions(CATEGORY_EXTENSION_RULES).filter((value) =>
        dedicated.has(value),
      ),
    ).toEqual([]);
  });

  it("orders compound extension groups by longest suffix first", () => {
    const minimumLengths = COMPOUND_EXTENSION_RULES.map((rule) =>
      Math.min(...rule.extensions.map((extension) => extension.length)),
    );
    expect(minimumLengths).toEqual([...minimumLengths].sort((a, b) => b - a));
  });

  it("keeps every rule asset valid", () => {
    const iconIds = [
      ...FILENAME_RULES.map((rule) => rule.iconId),
      ...COMPOUND_EXTENSION_RULES.map((rule) => rule.iconId),
      ...DEDICATED_EXTENSION_RULES.map((rule) => rule.iconId),
      ...CATEGORY_EXTENSION_RULES.map((rule) => rule.iconId),
    ];

    for (const iconId of iconIds) {
      expect(FILE_ICON_ASSETS).toHaveProperty(iconId);
    }
  });

  it("does not expose product assets without a registry consumer", () => {
    const referenced = new Set([
      "folder",
      "folder-open",
      "file-generic",
      ...FILENAME_RULES.map((rule) => rule.iconId),
      ...COMPOUND_EXTENSION_RULES.map((rule) => rule.iconId),
      ...DEDICATED_EXTENSION_RULES.map((rule) => rule.iconId),
      ...CATEGORY_EXTENSION_RULES.map((rule) => rule.iconId),
    ]);

    expect(
      Object.keys(FILE_ICON_ASSETS).filter((id) => !referenced.has(id)),
    ).toEqual([]);
  });

  it("matches every vendored SVG to the reviewed upstream checksum snapshot", () => {
    const symbolsRoot = resolve(import.meta.dirname, "assets/symbols");
    const expected = new Map(
      readFileSync(join(symbolsRoot, "CHECKSUMS.sha256"), "utf8")
        .trim()
        .split("\n")
        .map((line) => {
          const [hash, path] = line.split(/\s+/, 2);
          return [path, hash] as const;
        }),
    );
    const actualPaths = collectSvgPaths(symbolsRoot)
      .map((path) => relative(symbolsRoot, path).replaceAll("\\", "/"))
      .sort();

    expect([...expected.keys()].sort()).toEqual(actualPaths);
    for (const path of actualPaths) {
      const hash = createHash("sha256")
        .update(readFileSync(join(symbolsRoot, path)))
        .digest("hex");
      expect(hash, path).toBe(expected.get(path));
    }
  });

  it("keeps the presentation derivative geometry identical to Symbols image", () => {
    const symbolsRoot = resolve(import.meta.dirname, "assets/symbols");
    const image = readFileSync(join(symbolsRoot, "files/image.svg"), "utf8");
    const presentation = readFileSync(
      join(symbolsRoot, "files/presentation.svg"),
      "utf8",
    );

    expect(presentation).toBe(image.replaceAll("#C084FC", "#F59E0B"));
  });
});
