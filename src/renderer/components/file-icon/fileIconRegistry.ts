import type { FileIconId } from "./fileIconAssets";

export const FILE_ICON_CATEGORIES = [
  "folder",
  "document",
  "spreadsheet",
  "presentation",
  "code",
  "config",
  "data",
  "image",
  "audio",
  "video",
  "archive",
  "database",
  "binary",
  "font",
  "security",
  "package",
  "resource",
  "unknown",
] as const;

export type FileIconCategory = (typeof FILE_ICON_CATEGORIES)[number];
export type FileIconMatchedBy =
  | "node-kind"
  | "filename"
  | "compound-extension"
  | "extension"
  | "category"
  | "fallback";

export interface FileIconDescriptor {
  iconId: FileIconId;
  category: FileIconCategory;
  matchedBy: FileIconMatchedBy;
}

export interface FileIconResolveInput {
  name: string;
  nodeKind?: "file" | "directory";
  expanded?: boolean;
}

interface ExactFilenameRule {
  kind: "exact";
  names: readonly string[];
  iconId: FileIconId;
  category: FileIconCategory;
}

interface PatternFilenameRule {
  kind: "pattern";
  pattern: RegExp;
  iconId: FileIconId;
  category: FileIconCategory;
}

export type FilenameRule = ExactFilenameRule | PatternFilenameRule;

export interface ExtensionRule {
  extensions: readonly string[];
  iconId: FileIconId;
  category: FileIconCategory;
}

function exact(
  names: readonly string[],
  iconId: FileIconId,
  category: FileIconCategory,
): ExactFilenameRule {
  return { kind: "exact", names, iconId, category };
}

function pattern(
  filenamePattern: RegExp,
  iconId: FileIconId,
  category: FileIconCategory,
): PatternFilenameRule {
  return { kind: "pattern", pattern: filenamePattern, iconId, category };
}

function extensions(
  values: readonly string[],
  iconId: FileIconId,
  category: FileIconCategory,
): ExtensionRule {
  return { extensions: values, iconId, category };
}

export const FILENAME_RULES: readonly FilenameRule[] = [
  pattern(/^readme(?:\..+)?$/, "markdown", "document"),
  pattern(/^(?:changelog|changes|history)(?:\..+)?$/, "text", "document"),
  pattern(
    /^(?:license|licence|copying|notice)(?:\..+)?$/,
    "license",
    "security",
  ),
  pattern(/^\.env(?:\..+)?$/, "config", "config"),
  pattern(/^dockerfile(?:\..+)?$/, "docker", "package"),
  exact(
    [
      "package.json",
      "package.json5",
      "cargo.toml",
      "go.mod",
      "go.sum",
      "gemfile",
      "composer.json",
      "pyproject.toml",
      "requirements.txt",
      "pipfile",
    ],
    "package",
    "package",
  ),
  exact(
    [
      "package-lock.json",
      "npm-shrinkwrap.json",
      "yarn.lock",
      "pnpm-lock.yaml",
      "bun.lock",
      "bun.lockb",
      "cargo.lock",
      "gemfile.lock",
      "composer.lock",
      "poetry.lock",
      "uv.lock",
    ],
    "lock",
    "security",
  ),
  exact(["pnpm-workspace.yaml"], "pnpm", "package"),
  exact([".npmrc"], "npm", "config"),
  exact([".pnpmfile.cjs"], "pnpm", "config"),
  exact([".yarnrc", ".yarnrc.yml"], "yarn", "config"),
  exact(["bunfig.toml"], "bun", "config"),
  exact(["deno.json", "deno.jsonc"], "deno", "config"),
  exact([".nvmrc", ".node-version"], "node", "config"),
  exact(
    [
      "docker-compose.yml",
      "docker-compose.yaml",
      "compose.yml",
      "compose.yaml",
      ".dockerignore",
    ],
    "docker",
    "package",
  ),
  exact(
    [
      ".gitignore",
      ".gitattributes",
      ".gitmodules",
      ".gitkeep",
      ".git-blame-ignore-revs",
    ],
    "git",
    "config",
  ),
  exact(
    ["codeowners", "dependabot.yml", "dependabot.yaml"],
    "github",
    "config",
  ),
  exact(["angular.json"], "angular", "config"),
  exact([".editorconfig"], "editorconfig", "config"),
  exact(
    [
      "eslint.config.js",
      "eslint.config.mjs",
      "eslint.config.cjs",
      ".eslintrc",
      ".eslintrc.js",
      ".eslintrc.cjs",
      ".eslintrc.json",
      ".eslintignore",
    ],
    "eslint",
    "config",
  ),
  exact(
    [
      "prettier.config.js",
      "prettier.config.mjs",
      "prettier.config.cjs",
      ".prettierrc",
      ".prettierrc.json",
      ".prettierignore",
    ],
    "prettier",
    "config",
  ),
  exact(["biome.json", "biome.jsonc"], "biome", "config"),
  exact(["tsconfig.json", "jsconfig.json"], "tsconfig", "config"),
  exact(
    ["vite.config.ts", "vite.config.js", "vite.config.mts", "vite.config.mjs"],
    "vite",
    "config",
  ),
  exact(
    ["next.config.js", "next.config.mjs", "next.config.ts"],
    "next",
    "config",
  ),
  exact(
    [
      "tailwind.config.js",
      "tailwind.config.ts",
      "tailwind.config.cjs",
      "tailwind.config.mjs",
    ],
    "tailwind",
    "config",
  ),
  exact(["terraform.lock.hcl", ".terraform.lock.hcl"], "terraform", "config"),
  pattern(/^(?:makefile|gnumakefile)(?:\..+)?$/, "config", "config"),
] as const;

/** Longest suffix wins; tests enforce descending specificity and uniqueness. */
export const COMPOUND_EXTENSION_RULES: readonly ExtensionRule[] = [
  extensions(["tar.bz2", "tar.gz", "tar.xz", "tar.zst"], "archive", "archive"),
  extensions(["d.mts", "d.cts", "d.ts"], "declaration", "code"),
] as const;

/** High-recognition formats with a dedicated Symbols asset or Office family. */
export const DEDICATED_EXTENSION_RULES: readonly ExtensionRule[] = [
  extensions(["pdf"], "pdf", "document"),
  extensions(
    ["doc", "docx", "docm", "dot", "dotx", "wps", "wpt", "odt", "rtf", "pages"],
    "word",
    "document",
  ),
  extensions(
    [
      "xls",
      "xlsx",
      "xlsm",
      "xlsb",
      "xlt",
      "xltx",
      "et",
      "ett",
      "ods",
      "numbers",
      "csv",
      "tsv",
    ],
    "spreadsheet",
    "spreadsheet",
  ),
  extensions(
    [
      "ppt",
      "pptx",
      "pptm",
      "pot",
      "potx",
      "pps",
      "ppsx",
      "dps",
      "dpt",
      "odp",
      "key",
    ],
    "presentation",
    "presentation",
  ),
  extensions(["md", "mdx", "markdown", "mdown", "mkd"], "markdown", "document"),
  extensions(["txt", "text", "log", "out"], "text", "document"),
  extensions(["js", "mjs", "cjs"], "javascript", "code"),
  extensions(["jsx"], "react", "code"),
  extensions(["ts", "mts", "cts"], "typescript", "code"),
  extensions(["tsx"], "react", "code"),
  extensions(["py", "pyw", "pyi", "pyx"], "python", "code"),
  extensions(["rs"], "rust", "code"),
  extensions(["go"], "go", "code"),
  extensions(["java"], "java", "code"),
  extensions(["kt", "kts"], "kotlin", "code"),
  extensions(["c"], "c", "code"),
  extensions(["cc", "cpp", "cxx", "hpp", "hxx"], "cpp", "code"),
  extensions(["cs"], "csharp", "code"),
  extensions(["rb", "erb"], "ruby", "code"),
  extensions(["php"], "php", "code"),
  extensions(
    ["sh", "bash", "zsh", "fish", "ps1", "bat", "cmd"],
    "shell",
    "code",
  ),
  extensions(["html", "htm", "ejs", "hbs", "pug"], "html", "code"),
  extensions(["css"], "stylesheet", "code"),
  extensions(["scss", "sass"], "sass", "code"),
  extensions(["vue"], "vue", "code"),
  extensions(["svelte"], "svelte", "code"),
  extensions(["astro"], "astro", "code"),
  extensions(["json", "jsonc", "json5"], "json", "data"),
  extensions(["yaml", "yml"], "yaml", "config"),
  extensions(["xml", "xsl", "xslt"], "xml", "data"),
  extensions(["graphql", "gql"], "graphql", "data"),
  extensions(["ipynb"], "notebook", "document"),
  extensions(["db", "sqlite", "sqlite3"], "database", "database"),
  extensions(["svg", "svgz"], "svg", "image"),
  extensions(["tex", "latex"], "tex", "document"),
] as const;

/** Known long-tail formats intentionally collapse to a stable category asset. */
export const CATEGORY_EXTENSION_RULES: readonly ExtensionRule[] = [
  extensions(
    ["epub", "mobi", "azw", "azw3", "fb2", "djvu"],
    "word",
    "document",
  ),
  extensions(
    ["toml", "ini", "cfg", "conf", "properties", "plist", "hcl"],
    "config",
    "config",
  ),
  extensions(
    ["ndjson", "jsonl", "geojson", "parquet", "avro", "orc", "proto"],
    "json",
    "data",
  ),
  extensions(["sql", "dump", "mdb", "accdb"], "database", "database"),
  extensions(["mongo"], "mongo", "database"),
  extensions(
    [
      "png",
      "jpg",
      "jpeg",
      "gif",
      "webp",
      "bmp",
      "ico",
      "tif",
      "tiff",
      "avif",
      "heic",
      "psd",
      "ai",
      "sketch",
      "fig",
    ],
    "image",
    "image",
  ),
  extensions(
    ["mp3", "wav", "ogg", "flac", "aac", "m4a", "wma", "aiff", "opus"],
    "audio",
    "audio",
  ),
  extensions(
    ["mp4", "mov", "avi", "webm", "mkv", "flv", "wmv", "m4v"],
    "video",
    "video",
  ),
  extensions(
    ["zip", "tar", "gz", "tgz", "rar", "7z", "bz2", "xz", "zst", "lz", "lz4"],
    "archive",
    "archive",
  ),
  extensions(
    ["pem", "cert", "crt", "cer", "p12", "pfx", "asc", "gpg", "sig"],
    "security",
    "security",
  ),
  extensions(["ttf", "otf", "woff", "woff2", "eot"], "font", "font"),
  extensions(
    ["exe", "dll", "so", "dylib", "bin", "dat", "class", "jar", "wasm"],
    "binary",
    "binary",
  ),
  extensions(
    ["obj", "stl", "fbx", "gltf", "glb", "dae", "dwg", "dxf", "step", "stp"],
    "resource",
    "resource",
  ),
  extensions(["url", "webloc", "desktop"], "link", "resource"),
  extensions(
    [
      "h",
      "hh",
      "swift",
      "scala",
      "groovy",
      "lua",
      "r",
      "dart",
      "zig",
      "ex",
      "exs",
      "elm",
      "clj",
      "cljs",
      "hs",
      "fs",
      "fsx",
      "nim",
      "v",
      "sol",
    ],
    "code",
    "code",
  ),
] as const;

export const FILE_ICON_RULES = {
  filename: FILENAME_RULES,
  compoundExtension: COMPOUND_EXTENSION_RULES,
  dedicatedExtension: DEDICATED_EXTENSION_RULES,
  categoryExtension: CATEGORY_EXTENSION_RULES,
} as const;

function descriptor(
  iconId: FileIconId,
  category: FileIconCategory,
  matchedBy: FileIconMatchedBy,
): FileIconDescriptor {
  return { iconId, category, matchedBy };
}

function basenameFromPath(name: string): string {
  const normalizedPath = name.replaceAll("\\", "/");
  return normalizedPath
    .slice(normalizedPath.lastIndexOf("/") + 1)
    .toLowerCase();
}

function matchFilenameRule(name: string): FilenameRule | undefined {
  return FILENAME_RULES.find((rule) =>
    rule.kind === "exact" ? rule.names.includes(name) : rule.pattern.test(name),
  );
}

function matchCompoundRule(name: string): ExtensionRule | undefined {
  return COMPOUND_EXTENSION_RULES.find((rule) =>
    rule.extensions.some((extension) => name.endsWith(`.${extension}`)),
  );
}

function extensionFromFilename(name: string): string | null {
  const lastDot = name.lastIndexOf(".");
  return lastDot > 0 && lastDot < name.length - 1
    ? name.slice(lastDot + 1)
    : null;
}

function matchExtensionRule(
  extension: string,
  rules: readonly ExtensionRule[],
): ExtensionRule | undefined {
  return rules.find((rule) => rule.extensions.includes(extension));
}

export function resolveFileIconDescriptor({
  name,
  nodeKind = "file",
  expanded = false,
}: FileIconResolveInput): FileIconDescriptor {
  if (nodeKind === "directory") {
    return descriptor(
      expanded ? "folder-open" : "folder",
      "folder",
      "node-kind",
    );
  }

  const filename = basenameFromPath(name);
  const filenameRule = matchFilenameRule(filename);
  if (filenameRule) {
    return descriptor(filenameRule.iconId, filenameRule.category, "filename");
  }

  const compoundRule = matchCompoundRule(filename);
  if (compoundRule) {
    return descriptor(
      compoundRule.iconId,
      compoundRule.category,
      "compound-extension",
    );
  }

  const extension = extensionFromFilename(filename);
  if (extension) {
    const dedicatedRule = matchExtensionRule(
      extension,
      DEDICATED_EXTENSION_RULES,
    );
    if (dedicatedRule) {
      return descriptor(
        dedicatedRule.iconId,
        dedicatedRule.category,
        "extension",
      );
    }

    const categoryRule = matchExtensionRule(
      extension,
      CATEGORY_EXTENSION_RULES,
    );
    if (categoryRule) {
      return descriptor(categoryRule.iconId, categoryRule.category, "category");
    }
  }

  return descriptor("file-generic", "unknown", "fallback");
}
