import type {
  AgentInput,
  BashInput,
  FileEditInput,
  FileReadInput,
  FileWriteInput,
  GlobInput,
  GrepInput,
  NotebookEditInput,
  TaskCreateInput,
  TaskGetInput,
  TaskListInput,
  TaskUpdateInput,
  TodoWriteInput,
  WebFetchInput,
  WebSearchInput,
} from '@anthropic-ai/claude-agent-sdk/sdk-tools';

/** SDK tool input union shared by the Sidecar wire model and Renderer views. */
export type ToolInput =
  | AgentInput
  | BashInput
  | FileReadInput
  | FileWriteInput
  | FileEditInput
  | GlobInput
  | GrepInput
  | TodoWriteInput
  | TaskCreateInput
  | TaskUpdateInput
  | TaskGetInput
  | TaskListInput
  | WebFetchInput
  | WebSearchInput
  | NotebookEditInput;
