import type { WorkbenchStorage } from "@/workbench-sdk";

import WorldProposalReview from "../../../WorldProposalReview";
import { createCharacterFileProposalRepository } from "../data-access/characterFileProposalRepository";

interface CharacterProposalReviewProps {
  readonly storage: WorkbenchStorage;
  readonly projectTitle: string;
  readonly beforeMutate: () => Promise<boolean>;
  readonly onApplied: () => void | Promise<void>;
  readonly onClose: () => void;
}

/** 角色提案使用统一文件提案协议，包含逐项审阅、CAS 冲突处理和回收式删除。 */
export default function CharacterProposalReview({
  storage,
  projectTitle,
  beforeMutate,
  onApplied,
  onClose,
}: CharacterProposalReviewProps) {
  return (
    <WorldProposalReview
      storage={storage}
      projectTitle={projectTitle}
      beforeMutate={beforeMutate}
      onApplied={onApplied}
      onClose={onClose}
      repositoryFactory={createCharacterFileProposalRepository}
      reviewTitle="角色设计提案"
      proposalSubject="角色"
    />
  );
}
