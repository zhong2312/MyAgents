import type { WorkbenchStorage } from "@/workbench-sdk";

import WorldProposalReview from "../../../WorldProposalReview";
import { createFactionFileProposalRepository } from "../data-access/factionProposalRepository";

interface FactionProposalReviewProps {
  readonly storage: WorkbenchStorage;
  readonly projectTitle: string;
  readonly onApplied?: () => void | Promise<void>;
  readonly onClose: () => void;
}

export default function FactionProposalReview({
  storage,
  projectTitle,
  onApplied,
  onClose,
}: FactionProposalReviewProps) {
  return (
    <WorldProposalReview
      storage={storage}
      projectTitle={projectTitle}
      repositoryFactory={createFactionFileProposalRepository}
      reviewTitle="势力组织提案"
      proposalSubject="势力组织"
      onApplied={onApplied}
      onClose={onClose}
    />
  );
}
