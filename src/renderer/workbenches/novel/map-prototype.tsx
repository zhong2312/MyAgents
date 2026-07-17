import { createRoot } from "react-dom/client";

import WorldMapPrototype from "./WorldMapPrototype";

createRoot(document.getElementById("root")!).render(
  <main className="h-screen min-h-0 overflow-hidden bg-[var(--paper)] text-[var(--ink)]">
    <WorldMapPrototype />
  </main>,
);
