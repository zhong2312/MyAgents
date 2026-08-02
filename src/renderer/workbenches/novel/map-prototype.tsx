import { createRoot } from "react-dom/client";

import { NovelMemoryStorage } from "./testStorage";
import WorldMapPrototype from "./WorldMapPrototype";

// 独立原型入口：用内存存储演示地图（无真实项目数据时显示空状态）。
const storage = new NovelMemoryStorage({
  "world/setting-library/spatial-tree.json": JSON.stringify({
    schemaVersion: 1,
    nodes: [
      { id: "node-root", parentId: null, name: "九州", typeId: "continent", order: 0 },
      { id: "node-a", parentId: "node-root", name: "东境", typeId: "region", order: 0 },
      { id: "node-b", parentId: "node-root", name: "西荒", typeId: "region", order: 1 },
    ],
  }),
  "world/setting-library/meta.json": JSON.stringify({
    schemaVersion: 1,
    levelTypes: [
      { id: "continent", name: "大陆", description: "", suggestedParentTypeIds: [], version: 1, source: "builtin", updatedAt: "2026-01-01T00:00:00.000Z" },
      { id: "region", name: "区域", description: "", suggestedParentTypeIds: ["continent"], version: 1, source: "builtin", updatedAt: "2026-01-01T00:00:00.000Z" },
    ],
    settingTemplates: [],
    profiles: [],
  }),
});

createRoot(document.getElementById("root")!).render(
  <main className="h-screen min-h-0 overflow-hidden bg-[var(--paper)] text-[var(--ink)]">
    <WorldMapPrototype
      storage={storage}
      projectTitle="原型演示"
      isActive
    />
  </main>,
);
