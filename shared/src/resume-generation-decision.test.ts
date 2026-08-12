import { describe, expect, it } from "vitest";

import { resolveDocumentPolicy } from "./document-policy";
import { buildResumeGenerationDecision } from "./resume-generation-decision";

describe("resume generation decision", () => {
  it("honors a manual one-page override for non-government, non-consulting jobs", () => {
    const policy = resolveDocumentPolicy({
      title: "Business Operations Analyst",
      employer: "Acme Software",
      jobDescription: "Analyze customer operations and improve reporting.",
      resumeTargetPagesOverride: 1,
    });

    const decision = buildResumeGenerationDecision({ policy });

    expect(policy.allowsManualResumeTargetPages).toBe(true);
    expect(decision.targetPages).toBe(1);
    expect(decision.masterVariant).toBe("one_page");
    expect(decision.layoutMode).toBe("reference_1_page");
  });

  it("keeps government/public-sector consultant-like roles locked to two pages", () => {
    const policy = resolveDocumentPolicy({
      title: "Municipal Strategy Consultant",
      employer: "Government of Canada",
      jobDescription:
        "Support public-sector policy, regulatory compliance, and intergovernmental programs.",
      resumeTargetPagesOverride: 1,
    });

    const decision = buildResumeGenerationDecision({ policy });

    expect(policy.allowsManualResumeTargetPages).toBe(false);
    expect(policy.resumePagePolicyReason).toBe("public_sector_government");
    expect(decision.targetPages).toBe(2);
    expect(decision.masterVariant).toBe("two_page");
    expect(decision.layoutMode).toBe("reference_2_page");
  });
});
