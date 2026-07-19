import type { WorkbenchStorage } from "@/workbench-sdk";

import WorldProposalReview, {
  type FileProposalRepository,
} from "./WorldProposalReview";
import { createNovelPowerSystemProposalRepository } from "./powerSystemProposalRepository";

interface PowerSystemProposalReviewProps {
  readonly storage: WorkbenchStorage;
  readonly projectTitle: string;
  readonly onClose: () => void;
}

function createRepository(storage: WorkbenchStorage): FileProposalRepository {
  return createNovelPowerSystemProposalRepository(storage);
}

export default function PowerSystemProposalReview({
  storage,
  projectTitle,
  onClose,
}: PowerSystemProposalReviewProps) {
  return (
    <WorldProposalReview
      storage={storage}
      projectTitle={projectTitle}
      onClose={onClose}
      repositoryFactory={createRepository}
      reviewTitle="力量体系提案"
      proposalSubject="力量体系"
    />
  );
}
