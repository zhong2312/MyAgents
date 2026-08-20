import { describe, expect, it } from "vitest";

import {
  isManuscriptTrackingEvidenceGrounded,
  partitionManuscriptTrackingChangesByEvidence,
} from "./manuscriptTrackingEvidence";

describe("正文连续性证据校验", () => {
  const source =
    "青岚宗三年一回的定灵试，镇上人都叫测灵，过了十五再测，是要纳银。";

  it("只接受正文中可逐字定位的连续原文", () => {
    expect(isManuscriptTrackingEvidenceGrounded(source, "镇上人都叫测灵")).toBe(
      true,
    );
    expect(
      isManuscriptTrackingEvidenceGrounded(
        source,
        "镇上称“测灵”，过了十五岁再测需缴银",
      ),
    ).toBe(false);
  });

  it("按原顺序分离有效证据与模型改写的无效证据", () => {
    const valid = { id: "valid", evidence: "青岚宗三年一回的定灵试" };
    const invalid = { id: "invalid", evidence: "青岚宗每三年举办测灵" };

    expect(
      partitionManuscriptTrackingChangesByEvidence(source, [invalid, valid]),
    ).toEqual({ grounded: [valid], ungrounded: [invalid] });
  });
});
