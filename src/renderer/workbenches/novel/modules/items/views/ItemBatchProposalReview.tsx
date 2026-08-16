import type { WorkbenchStorage } from "@/workbench-sdk";

import WorldProposalReview from "../../../WorldProposalReview";
import { createItemFileProposalRepository } from "../data-access/itemFileProposalRepository";

interface ItemBatchProposalReviewProps {
  readonly storage: WorkbenchStorage;
  readonly projectTitle: string;
  readonly beforeMutate: () => Promise<boolean>;
  readonly onApplied: () => void | Promise<void>;
  readonly onClose: () => void;
}

/** 物品提案使用统一文件提案协议，候选项可逐项应用、拒绝、删除或解决冲突。 */
export default function ItemBatchProposalReview({
  storage,
  projectTitle,
  beforeMutate,
  onApplied,
  onClose,
}: ItemBatchProposalReviewProps) {
  return (
    <WorldProposalReview
      storage={storage}
      projectTitle={projectTitle}
      beforeMutate={beforeMutate}
      onApplied={onApplied}
      onClose={onClose}
      repositoryFactory={createItemFileProposalRepository}
      reviewTitle="物品提案"
      proposalSubject="物品"
    />
  );
}
