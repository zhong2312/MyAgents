export type FileProposalStatus =
  | "pending"
  | "partially-applied"
  | "applied"
  | "rejected";

export interface FileProposalChange {
  readonly id: string;
  readonly targetPath: string;
  readonly operation: "create" | "modify";
  readonly summary: string;
  readonly status: "pending" | "applied" | "rejected";
  /** The proposal-generation baseline. Empty for a newly proposed file. */
  readonly beforeContent: string;
  readonly afterContent: string;
  /** Latest formal content read while materializing the review queue. */
  readonly currentContent: string | null;
  /** False for legacy proposals that did not persist an object-level baseline. */
  readonly baseContentAvailable?: boolean;
  readonly conflict: boolean;
  readonly loadError: string | null;
  readonly inferred?: boolean;
}

export interface FileProposal {
  readonly manifest: {
    readonly proposalId: string;
    readonly title: string;
    readonly description: string;
    readonly createdAt: string;
    readonly changes: readonly {
      readonly status: FileProposalChange["status"];
    }[];
  };
  readonly changes: readonly FileProposalChange[];
}

export interface FileProposalLoadError {
  readonly proposalId: string;
  readonly message: string;
}

export type FileProposalConflictResolution =
  | {
      readonly strategy: "use-proposal";
      readonly expectedCurrentContent: string | null;
    }
  | {
      readonly strategy: "merge";
      readonly expectedCurrentContent: string | null;
      readonly content: string;
    };

export interface FileProposalRepository {
  list(): Promise<{
    readonly proposals: readonly FileProposal[];
    readonly errors: readonly FileProposalLoadError[];
  }>;
  deleteProposals(proposalIds: readonly string[]): Promise<void>;
  apply(
    proposalId: string,
    changeIds: readonly string[],
    projectTitle: string,
  ): Promise<FileProposal>;
  reject(
    proposalId: string,
    changeIds: readonly string[],
  ): Promise<FileProposal>;
  delete(
    proposalId: string,
    changeIds: readonly string[],
  ): Promise<FileProposal | null>;
  /**
   * Applies one conflicted change after explicit author resolution. The domain
   * repository must compare expectedCurrentContent again and validate the final
   * domain object before writing its formal source.
   */
  resolveConflict(
    proposalId: string,
    changeId: string,
    resolution: FileProposalConflictResolution,
    projectTitle: string,
  ): Promise<FileProposal>;
}
