import { createRoot } from "react-dom/client";

import CharacterLibraryPrototype from "./CharacterLibraryPrototype";
import { NovelMemoryStorage } from "./testStorage";

import "../../i18n";

const storage = new NovelMemoryStorage({});

createRoot(document.getElementById("root")!).render(
  <main className="h-screen min-h-0 overflow-hidden bg-[var(--paper)] text-[var(--ink)]">
    <CharacterLibraryPrototype
      storage={storage}
      projectTitle="枪出如龙"
      isActive
    />
  </main>,
);
