export type NovelAiAssistTarget =
  | {
      readonly kind: "world";
      readonly label: string;
    }
  | {
      readonly kind: "spatial-children";
      readonly label: string;
      readonly nodeId: string;
    }
  | {
      readonly kind: "setting-page";
      readonly label: string;
      readonly nodeId: string;
      readonly settingId: string;
    }
  | {
      readonly kind: "level-type" | "setting-template" | "profile";
      readonly label: string;
      readonly entityId: string;
    };
