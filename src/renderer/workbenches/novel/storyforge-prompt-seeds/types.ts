/**
 * Minimal StoryForge prompt seed contract retained for the imported snapshot.
 * These fields are converted to the MyAgents prompt-library model at runtime.
 */
export interface PromptParameter {
  readonly key: string;
  readonly label: string;
  readonly type: "select" | "slider" | "number" | "text" | "boolean";
  readonly options?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly maxFromModelOutput?: boolean;
  readonly default: string | number | boolean;
  readonly description?: string;
  readonly optional?: boolean;
}

export interface PromptExample {
  readonly id: string;
  readonly text: string;
  readonly rating?: number;
  readonly source: "system" | "ai-generated" | "user-marked";
  readonly note?: string;
  readonly createdAt: number;
}

export interface PromptTemplate {
  readonly id?: number;
  readonly scope: "system" | "user";
  readonly moduleKey: string;
  readonly promptType: string;
  readonly name: string;
  readonly description: string;
  readonly systemPrompt: string;
  readonly userPromptTemplate: string;
  readonly variables: readonly string[];
  readonly modelOverride?: {
    readonly temperature?: number;
    readonly maxTokens?: number;
  };
  readonly parentId?: number;
  readonly isActive: boolean;
  readonly isDefault?: boolean;
  readonly genres?: readonly string[];
  readonly parameters?: readonly PromptParameter[];
  readonly examples?: {
    readonly good?: readonly PromptExample[];
    readonly bad?: readonly PromptExample[];
  };
  readonly lengthMode?: "short" | "medium" | "long";
  readonly continuityMode?: "inherit" | "required" | "off";
  readonly createdAt: number;
  readonly updatedAt: number;
}
