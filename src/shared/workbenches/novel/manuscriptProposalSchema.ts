import { z } from "zod";

export const manuscriptWritingModeSchema = z.enum([
  "generate",
  "continue",
  "revise",
  "expand",
]);

export const manuscriptProposalCandidateStatusSchema = z.enum([
  "pending",
  "applied",
  "rejected",
]);

export const manuscriptProposalSchema = z
  .object({
    schemaVersion: z.literal(1),
    proposalId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/u),
    draftId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/u),
    runId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/u),
    title: z.string().min(1).max(160),
    description: z.string().max(20_000),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    source: z
      .object({
        chapterId: z.string().min(1),
        chapterTitle: z.string().min(1),
        chapterPath: z.string().regex(/^manuscript\/chapters\/\d{6}\.md$/u),
        sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
        sourceContent: z.string(),
        rangeStart: z.number().int().nonnegative(),
        rangeEnd: z.number().int().nonnegative(),
        mode: manuscriptWritingModeSchema,
      })
      .strict(),
    candidate: z
      .object({
        id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/u),
        status: manuscriptProposalCandidateStatusSchema,
        content: z.string().min(1),
        appliedContent: z.string().nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((proposal, context) => {
    if (proposal.source.rangeEnd < proposal.source.rangeStart) {
      context.addIssue({
        code: "custom",
        path: ["source", "rangeEnd"],
        message: "rangeEnd 不得小于 rangeStart",
      });
    }
    if (proposal.source.rangeEnd > proposal.source.sourceContent.length) {
      context.addIssue({
        code: "custom",
        path: ["source", "rangeEnd"],
        message: "正文范围越界",
      });
    }
  });

export type ManuscriptWritingMode = z.infer<typeof manuscriptWritingModeSchema>;
export type ManuscriptProposal = z.infer<typeof manuscriptProposalSchema>;

export function serializeManuscriptProposal(
  proposal: ManuscriptProposal,
): string {
  return `${JSON.stringify(manuscriptProposalSchema.parse(proposal), null, 2)}\n`;
}
