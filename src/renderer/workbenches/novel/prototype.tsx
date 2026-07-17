import { createRoot } from "react-dom/client";

import "@/i18n";

import AiWorldDesignPrototype, {
  type AiPrototypeMode,
} from "./AiWorldDesignPrototype";
import { createEmptyNovelStorage } from "./testStorage";

const storage = createEmptyNovelStorage();
const modeParam = new URLSearchParams(window.location.search).get("mode");
const mode: AiPrototypeMode =
  modeParam === "meta" || modeParam === "prompts" ? modeParam : "library";

createRoot(document.getElementById("root")!).render(
  <AiWorldDesignPrototype
    storage={storage}
    mode={mode}
    onNavigate={(route) => {
      window.location.search =
        route === "lore-config"
          ? "?mode=meta"
          : route === "ai-prompts"
            ? "?mode=prompts"
            : "";
    }}
  />,
);
