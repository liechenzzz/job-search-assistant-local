import { resolveDocumentPolicy } from "@shared/document-policy.js";
import { buildJdKeywordProfile } from "@shared/jd-keyword-profile.js";
import { buildJdQualificationProfile } from "@shared/jd-qualification-profile.js";
import { buildResumeGenerationDecision } from "@shared/resume-generation-decision.js";
import type {
  Job,
  ResumeGenerationDecision,
  ResumeGenerationReferenceSummary,
} from "@shared/types";
import {
  findReferenceChunksForQualifications,
  selectFormatReferenceSummaries,
  summarizeEvidenceReferenceHits,
} from "./resume-references";

export async function resolveResumeGenerationDecisionForJob(
  job: Pick<
    Job,
    | "source"
    | "title"
    | "employer"
    | "jobDescription"
    | "jobUrl"
    | "applicationLink"
    | "location"
    | "resumeTargetPagesOverride"
  >,
  options: { includeEvidenceReferences?: boolean } = {},
): Promise<ResumeGenerationDecision> {
  const policy = resolveDocumentPolicy({
    source: job.source,
    title: job.title,
    employer: job.employer,
    jobDescription: job.jobDescription,
    jobUrl: job.jobUrl,
    applicationLink: job.applicationLink,
    location: job.location,
    resumeTargetPagesOverride: job.resumeTargetPagesOverride,
  });
  const keywordProfile = buildJdKeywordProfile({
    title: job.title,
    employer: job.employer,
    jobDescription: job.jobDescription || "",
  });
  const baseDecision = buildResumeGenerationDecision({
    policy,
    keywordProfile,
  });
  const formatReferences = await selectFormatReferenceSummaries({
    referenceRoleFamilies: baseDecision.referenceRoleFamilies,
    targetPages: baseDecision.targetPages,
    maxItems: 2,
  });
  let evidenceReferences: ResumeGenerationReferenceSummary[] = [];
  if (options.includeEvidenceReferences) {
    const qualificationProfile = buildJdQualificationProfile({
      title: job.title,
      employer: job.employer,
      jobDescription: job.jobDescription || "",
    });
    const hits = await findReferenceChunksForQualifications({
      qualificationProfile,
      keywordProfile,
      maxChunksPerQualification: 2,
    });
    evidenceReferences = summarizeEvidenceReferenceHits(hits, 5);
  }
  return buildResumeGenerationDecision({
    policy,
    keywordProfile,
    formatReferences,
    evidenceReferences,
  });
}
