import angularUrl from "./assets/symbols/files/angular.svg";
import astroUrl from "./assets/symbols/files/astro.svg";
import audioUrl from "./assets/symbols/files/audio.svg";
import biomeUrl from "./assets/symbols/files/biome.svg";
import bracketsBlueUrl from "./assets/symbols/files/brackets-blue.svg";
import bunUrl from "./assets/symbols/files/bun.svg";
import cUrl from "./assets/symbols/files/c.svg";
import codeBlueUrl from "./assets/symbols/files/code-blue.svg";
import codeOrangeUrl from "./assets/symbols/files/code-orange.svg";
import codeSkyUrl from "./assets/symbols/files/code-sky.svg";
import compressedUrl from "./assets/symbols/files/compressed.svg";
import cplusUrl from "./assets/symbols/files/cplus.svg";
import csharpUrl from "./assets/symbols/files/csharp.svg";
import csvUrl from "./assets/symbols/files/csv.svg";
import databaseUrl from "./assets/symbols/files/database.svg";
import denoUrl from "./assets/symbols/files/deno.svg";
import dockerUrl from "./assets/symbols/files/docker.svg";
import documentUrl from "./assets/symbols/files/document.svg";
import dtsUrl from "./assets/symbols/files/dts.svg";
import editorconfigUrl from "./assets/symbols/files/editorconfig.svg";
import eslintUrl from "./assets/symbols/files/eslint.svg";
import exeUrl from "./assets/symbols/files/exe.svg";
import fontUrl from "./assets/symbols/files/font.svg";
import gearUrl from "./assets/symbols/files/gear.svg";
import gitUrl from "./assets/symbols/files/git.svg";
import githubUrl from "./assets/symbols/files/github.svg";
import goUrl from "./assets/symbols/files/go.svg";
import graphqlUrl from "./assets/symbols/files/graphql.svg";
import imageUrl from "./assets/symbols/files/image.svg";
import javaUrl from "./assets/symbols/files/java.svg";
import jsUrl from "./assets/symbols/files/js.svg";
import kotlinUrl from "./assets/symbols/files/kotlin.svg";
import licenseUrl from "./assets/symbols/files/license.svg";
import linkUrl from "./assets/symbols/files/link.svg";
import lockUrl from "./assets/symbols/files/lock.svg";
import markdownUrl from "./assets/symbols/files/markdown.svg";
import mongoUrl from "./assets/symbols/files/mongo.svg";
import nextUrl from "./assets/symbols/files/next.svg";
import nodeUrl from "./assets/symbols/files/node.svg";
import notebookUrl from "./assets/symbols/files/notebook.svg";
import npmUrl from "./assets/symbols/files/npm.svg";
import pdfUrl from "./assets/symbols/files/pdf.svg";
import phpUrl from "./assets/symbols/files/php.svg";
import pnpmUrl from "./assets/symbols/files/pnpm.svg";
import presentationUrl from "./assets/symbols/files/presentation.svg";
import prettierUrl from "./assets/symbols/files/prettier.svg";
import pythonUrl from "./assets/symbols/files/python.svg";
import reactUrl from "./assets/symbols/files/react.svg";
import resourceUrl from "./assets/symbols/files/resource.svg";
import rubyUrl from "./assets/symbols/files/ruby.svg";
import rustUrl from "./assets/symbols/files/rust.svg";
import sassUrl from "./assets/symbols/files/sass.svg";
import shellUrl from "./assets/symbols/files/shell.svg";
import svelteUrl from "./assets/symbols/files/svelte.svg";
import svgUrl from "./assets/symbols/files/svg.svg";
import tailwindUrl from "./assets/symbols/files/tailwind.svg";
import terraformUrl from "./assets/symbols/files/terraform.svg";
import texUrl from "./assets/symbols/files/tex.svg";
import textUrl from "./assets/symbols/files/text.svg";
import tsUrl from "./assets/symbols/files/ts.svg";
import tsconfigUrl from "./assets/symbols/files/tsconfig.svg";
import videoUrl from "./assets/symbols/files/video.svg";
import viteUrl from "./assets/symbols/files/vite.svg";
import vueUrl from "./assets/symbols/files/vue.svg";
import xmlUrl from "./assets/symbols/files/xml.svg";
import yamlUrl from "./assets/symbols/files/yaml.svg";
import yarnUrl from "./assets/symbols/files/yarn.svg";
import folderOpenUrl from "./assets/symbols/folders/folder-open.svg";
import folderUrl from "./assets/symbols/folders/folder.svg";

export const SYMBOLS_UPSTREAM = {
  name: "Symbols",
  version: "0.0.25",
  commit: "296ef1b62287fb2315cb5651e552e09e8c8e1de8",
  repository: "https://github.com/miguelsolorio/symbols",
  license: "MIT",
} as const;

function symbolsAsset(src: string, upstreamPath: string) {
  return { src, upstreamPath } as const;
}

/**
 * Stable product-facing IDs. Consumers never address this map directly;
 * resolver rules choose an ID and FileIcon owns URL rendering.
 */
export const FILE_ICON_ASSETS = {
  folder: symbolsAsset(folderUrl, "src/icons/folders/folder.svg"),
  "folder-open": symbolsAsset(
    folderOpenUrl,
    "src/icons/folders/folder-open.svg",
  ),
  "file-generic": symbolsAsset(documentUrl, "src/icons/files/document.svg"),
  text: symbolsAsset(textUrl, "src/icons/files/text.svg"),
  markdown: symbolsAsset(markdownUrl, "src/icons/files/markdown.svg"),
  pdf: symbolsAsset(pdfUrl, "src/icons/files/pdf.svg"),
  word: symbolsAsset(notebookUrl, "src/icons/files/notebook.svg"),
  spreadsheet: symbolsAsset(csvUrl, "src/icons/files/csv.svg"),
  presentation: symbolsAsset(
    presentationUrl,
    "derived:src/icons/files/image.svg",
  ),
  javascript: symbolsAsset(jsUrl, "src/icons/files/js.svg"),
  typescript: symbolsAsset(tsUrl, "src/icons/files/ts.svg"),
  declaration: symbolsAsset(dtsUrl, "src/icons/files/dts.svg"),
  python: symbolsAsset(pythonUrl, "src/icons/files/python.svg"),
  rust: symbolsAsset(rustUrl, "src/icons/files/rust.svg"),
  go: symbolsAsset(goUrl, "src/icons/files/go.svg"),
  java: symbolsAsset(javaUrl, "src/icons/files/java.svg"),
  kotlin: symbolsAsset(kotlinUrl, "src/icons/files/kotlin.svg"),
  c: symbolsAsset(cUrl, "src/icons/files/c.svg"),
  cpp: symbolsAsset(cplusUrl, "src/icons/files/cplus.svg"),
  csharp: symbolsAsset(csharpUrl, "src/icons/files/csharp.svg"),
  ruby: symbolsAsset(rubyUrl, "src/icons/files/ruby.svg"),
  php: symbolsAsset(phpUrl, "src/icons/files/php.svg"),
  shell: symbolsAsset(shellUrl, "src/icons/files/shell.svg"),
  html: symbolsAsset(codeOrangeUrl, "src/icons/files/code-orange.svg"),
  stylesheet: symbolsAsset(codeSkyUrl, "src/icons/files/code-sky.svg"),
  code: symbolsAsset(codeBlueUrl, "src/icons/files/code-blue.svg"),
  json: symbolsAsset(bracketsBlueUrl, "src/icons/files/brackets-blue.svg"),
  yaml: symbolsAsset(yamlUrl, "src/icons/files/yaml.svg"),
  xml: symbolsAsset(xmlUrl, "src/icons/files/xml.svg"),
  graphql: symbolsAsset(graphqlUrl, "src/icons/files/graphql.svg"),
  config: symbolsAsset(gearUrl, "src/icons/files/gear.svg"),
  editorconfig: symbolsAsset(
    editorconfigUrl,
    "src/icons/files/editorconfig.svg",
  ),
  eslint: symbolsAsset(eslintUrl, "src/icons/files/eslint.svg"),
  prettier: symbolsAsset(prettierUrl, "src/icons/files/prettier.svg"),
  biome: symbolsAsset(biomeUrl, "src/icons/files/biome.svg"),
  tsconfig: symbolsAsset(tsconfigUrl, "src/icons/files/tsconfig.svg"),
  database: symbolsAsset(databaseUrl, "src/icons/files/database.svg"),
  mongo: symbolsAsset(mongoUrl, "src/icons/files/mongo.svg"),
  notebook: symbolsAsset(notebookUrl, "src/icons/files/notebook.svg"),
  image: symbolsAsset(imageUrl, "src/icons/files/image.svg"),
  svg: symbolsAsset(svgUrl, "src/icons/files/svg.svg"),
  audio: symbolsAsset(audioUrl, "src/icons/files/audio.svg"),
  video: symbolsAsset(videoUrl, "src/icons/files/video.svg"),
  archive: symbolsAsset(compressedUrl, "src/icons/files/compressed.svg"),
  binary: symbolsAsset(exeUrl, "src/icons/files/exe.svg"),
  font: symbolsAsset(fontUrl, "src/icons/files/font.svg"),
  security: symbolsAsset(licenseUrl, "src/icons/files/license.svg"),
  license: symbolsAsset(licenseUrl, "src/icons/files/license.svg"),
  lock: symbolsAsset(lockUrl, "src/icons/files/lock.svg"),
  git: symbolsAsset(gitUrl, "src/icons/files/git.svg"),
  github: symbolsAsset(githubUrl, "src/icons/files/github.svg"),
  package: symbolsAsset(npmUrl, "src/icons/files/npm.svg"),
  npm: symbolsAsset(npmUrl, "src/icons/files/npm.svg"),
  pnpm: symbolsAsset(pnpmUrl, "src/icons/files/pnpm.svg"),
  yarn: symbolsAsset(yarnUrl, "src/icons/files/yarn.svg"),
  bun: symbolsAsset(bunUrl, "src/icons/files/bun.svg"),
  node: symbolsAsset(nodeUrl, "src/icons/files/node.svg"),
  deno: symbolsAsset(denoUrl, "src/icons/files/deno.svg"),
  docker: symbolsAsset(dockerUrl, "src/icons/files/docker.svg"),
  react: symbolsAsset(reactUrl, "src/icons/files/react.svg"),
  vue: symbolsAsset(vueUrl, "src/icons/files/vue.svg"),
  svelte: symbolsAsset(svelteUrl, "src/icons/files/svelte.svg"),
  angular: symbolsAsset(angularUrl, "src/icons/files/angular.svg"),
  astro: symbolsAsset(astroUrl, "src/icons/files/astro.svg"),
  next: symbolsAsset(nextUrl, "src/icons/files/next.svg"),
  tailwind: symbolsAsset(tailwindUrl, "src/icons/files/tailwind.svg"),
  sass: symbolsAsset(sassUrl, "src/icons/files/sass.svg"),
  terraform: symbolsAsset(terraformUrl, "src/icons/files/terraform.svg"),
  vite: symbolsAsset(viteUrl, "src/icons/files/vite.svg"),
  tex: symbolsAsset(texUrl, "src/icons/files/tex.svg"),
  link: symbolsAsset(linkUrl, "src/icons/files/link.svg"),
  resource: symbolsAsset(resourceUrl, "src/icons/files/resource.svg"),
} as const;

export type FileIconId = keyof typeof FILE_ICON_ASSETS;
