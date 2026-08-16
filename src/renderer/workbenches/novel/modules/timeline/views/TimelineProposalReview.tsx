import type { WorkbenchStorage } from "@/workbench-sdk";

import WorldProposalReview from "../../../WorldProposalReview";
import { createTimelineFileProposalRepository } from "../data-access/timelineProposalRepository";

interface TimelineProposalReviewProps {
  readonly storage: WorkbenchStorage;
  readonly projectTitle: string;
  readonly onApplied?: () => void | Promise<void>;
  readonly onClose: () => void;
}

export default function TimelineProposalReview({
  storage,
  projectTitle,
  onApplied,
  onClose,
}: TimelineProposalReviewProps) {
  return (
    <WorldProposalReview
      storage={storage}
      projectTitle={projectTitle}
      repositoryFactory={createTimelineFileProposalRepository}
      reviewTitle="时间线提案"
      proposalSubject="时间线"
      onApplied={onApplied}
      onClose={onClose}
    />
  );
}
