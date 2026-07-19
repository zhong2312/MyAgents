import type { WorkbenchStorage, WorkbenchTextFile } from "@/workbench-sdk";

import {
  createDefaultCreativeProfile,
  createEmptyInspirationLibrary,
  createEmptyNarrativeDesign,
  NARRATIVE_STUDIO_PATHS,
  parseCreativeProfile,
  parseInspirationLibrary,
  parseNarrativeDesign,
  serializeCreativeProfile,
  serializeInspirationLibrary,
  serializeNarrativeDesign,
  type CreativeProfile,
  type InspirationLibrary,
  type NarrativeDesign,
} from "./narrativeStudioSchema";

export interface LoadedNarrativeStudioProject {
  readonly narrative: NarrativeDesign;
  readonly narrativeContent: string;
  readonly inspirations: InspirationLibrary;
  readonly inspirationContent: string;
  readonly profile: CreativeProfile;
  readonly profileContent: string;
}

export interface NovelNarrativeStudioRepository {
  load(): Promise<LoadedNarrativeStudioProject>;
  saveNarrative(
    current: LoadedNarrativeStudioProject,
    value: NarrativeDesign,
  ): Promise<LoadedNarrativeStudioProject>;
  saveInspirations(
    current: LoadedNarrativeStudioProject,
    value: InspirationLibrary,
  ): Promise<LoadedNarrativeStudioProject>;
  saveProfile(
    current: LoadedNarrativeStudioProject,
    value: CreativeProfile,
  ): Promise<LoadedNarrativeStudioProject>;
}

export interface NarrativeStudioInitializationInput {
  readonly title: string;
  readonly genres: readonly string[];
  readonly createdAt: string;
}

async function ensureTextFile(
  storage: WorkbenchStorage,
  path: string,
  content: string,
): Promise<WorkbenchTextFile> {
  const [info] = await storage.stat([path]);
  if (info?.exists) return storage.readText(path);
  try {
    return await storage.createText(path, content, { createParents: true });
  } catch {
    return storage.readText(path);
  }
}

function replaceLoaded(
  current: LoadedNarrativeStudioProject,
  patch: Partial<LoadedNarrativeStudioProject>,
): LoadedNarrativeStudioProject {
  return Object.freeze({ ...current, ...patch });
}

export function createNarrativeStudioInitializationFiles(
  input: NarrativeStudioInitializationInput,
): readonly { readonly path: string; readonly content: string }[] {
  return [
    {
      path: NARRATIVE_STUDIO_PATHS.narrative,
      content: serializeNarrativeDesign(
        createEmptyNarrativeDesign(input.createdAt),
      ),
    },
    {
      path: NARRATIVE_STUDIO_PATHS.inspirations,
      content: serializeInspirationLibrary(
        createEmptyInspirationLibrary(input.createdAt),
      ),
    },
    {
      path: NARRATIVE_STUDIO_PATHS.profile,
      content: serializeCreativeProfile(
        createDefaultCreativeProfile(
          input.title,
          input.genres,
          input.createdAt,
        ),
      ),
    },
  ];
}

export function createNovelNarrativeStudioRepository(
  storage: WorkbenchStorage,
  projectTitle: string,
  projectGenres: readonly string[],
): NovelNarrativeStudioRepository {
  const repository: NovelNarrativeStudioRepository = {
    async load() {
      if (!storage.isAvailable) {
        throw new Error("叙事设计仅在 MyAgents 桌面端可用");
      }
      const createdAt = new Date().toISOString();
      const initialFiles = createNarrativeStudioInitializationFiles({
        title: projectTitle,
        genres: projectGenres,
        createdAt,
      });
      const [narrativeFile, inspirationFile, profileFile] = await Promise.all(
        initialFiles.map((file) =>
          ensureTextFile(storage, file.path, file.content),
        ),
      );
      return Object.freeze({
        narrative: parseNarrativeDesign(narrativeFile.content),
        narrativeContent: narrativeFile.content,
        inspirations: parseInspirationLibrary(inspirationFile.content),
        inspirationContent: inspirationFile.content,
        profile: parseCreativeProfile(profileFile.content),
        profileContent: profileFile.content,
      });
    },

    async saveNarrative(current, value) {
      const nextValue = { ...value, updatedAt: new Date().toISOString() };
      const content = serializeNarrativeDesign(nextValue);
      const parsed = parseNarrativeDesign(content);
      const file = await storage.writeText(
        NARRATIVE_STUDIO_PATHS.narrative,
        content,
        { expectedContent: current.narrativeContent },
      );
      return replaceLoaded(current, {
        narrative: parsed,
        narrativeContent: file.content,
      });
    },

    async saveInspirations(current, value) {
      const nextValue = { ...value, updatedAt: new Date().toISOString() };
      const content = serializeInspirationLibrary(nextValue);
      const parsed = parseInspirationLibrary(content);
      const file = await storage.writeText(
        NARRATIVE_STUDIO_PATHS.inspirations,
        content,
        { expectedContent: current.inspirationContent },
      );
      return replaceLoaded(current, {
        inspirations: parsed,
        inspirationContent: file.content,
      });
    },

    async saveProfile(current, value) {
      const nextValue = { ...value, updatedAt: new Date().toISOString() };
      const content = serializeCreativeProfile(nextValue);
      const parsed = parseCreativeProfile(content);
      const file = await storage.writeText(
        NARRATIVE_STUDIO_PATHS.profile,
        content,
        { expectedContent: current.profileContent },
      );
      return replaceLoaded(current, {
        profile: parsed,
        profileContent: file.content,
      });
    },
  };
  return Object.freeze(repository);
}

