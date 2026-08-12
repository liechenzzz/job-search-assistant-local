/**
 * Real LLM smoke test — run with: npx tsx scripts/real-llm-smoke.mts
 * Requires: .env with LLM_PROVIDER, LLM_API_KEY, MODEL configured
 *
 * Runs generateTailoring() with real LLM and dumps bullet-level trace
 * so you can verify: claim extraction, repair, fallback, positioning.
 */
import "dotenv/config";
import { resolveLlmModel, createConfiguredLlmService } from "../src/server/services/modelSelection.js";
import { generateTailoring } from "../src/server/services/summary.js";

const JD = [
  "Market Intelligence Analyst — Health Sector",
  "MaRS Discovery District",
  "",
  "About the role:",
  "We are looking for a Market Intelligence Analyst to join our Health Venture",
  "team. You will conduct market intelligence and sector opportunity research",
  "to identify growth opportunities for health innovation ventures.",
  "",
  "Key Responsibilities:",
  "- Conduct market intelligence and competitive landscape analysis",
  "- Perform market sizing and TAM analysis for health ventures",
  "- Synthesize research findings into executive-ready reports",
  "- Engage with healthcare startups and stakeholders",
  "- Present market insights to internal and external audiences",
  "",
  "Qualifications:",
  "- 2+ years experience in market research, consulting, or business analysis",
  "- Strong analytical and quantitative skills (Excel, SQL)",
  "- Experience with stakeholder engagement and client communication",
  "- Interest in health innovation and AI/technology trends",
].join("\n");

const PROFILE = {
  basics: { name: "Jane Candidate", label: "Research & Policy Analyst" },
  sections: {
    experience: {
      items: [
        {
          id: "experience-research-consultancy",
          company: "Regional Research Consultancy",
          position: "Research Analyst / Consultant",
          location: "Toronto",
          date: "2025 — Present",
          summary: [
            "Conducted applied labour-market and policy research across Durham,",
            "Waterloo, and Northwestern Ontario. Analysed Job Bank, Statistics",
            "Canada RTRA, and occupational outlook data to compare demand patterns,",
            "wage levels, and sector trends across regions. Reviewed 35+ regional",
            "strategies and policy documents. Prepared evidence packs and briefing",
            "materials for municipal and public-sector clients. Supported workforce",
            "development and sector prioritization projects with quantitative",
            "analysis and stakeholder engagement.",
          ].join(" "),
          visible: true,
        },
        {
          id: "experience-innovation-hub",
          company: "Municipal Innovation Hub",
          position: "Project Coordinator",
          location: "Mississauga",
          date: "2024 — 2025",
          summary: [
            "Supported innovation ecosystem programs for the City of Mississauga.",
            "Coordinated stakeholder workshops and roundtables with entrepreneurs,",
            "municipal staff, and ecosystem partners. Prepared program reports,",
            "communications materials, and KPI dashboards.",
          ].join(" "),
          visible: true,
        },
      ],
    },
  },
};

async function main() {
  console.log("=== Real LLM Smoke Test ===\n");

  // Verify LLM config
  const model = await resolveLlmModel("tailoring");
  console.log(`Model resolved: ${model}`);

  const llm = await createConfiguredLlmService();
  if (!llm) {
    console.error("ERROR: No LLM service configured. Set LLM_PROVIDER + LLM_API_KEY in .env");
    process.exit(1);
  }

  console.log(`JD: ${JD.slice(0, 80)}...\n`);
  console.log("Running generateTailoring()...\n");

  const result = await generateTailoring(JD, PROFILE);

  if (!result.success || !result.data) {
    console.error("FAILED:", result.error);
    process.exit(1);
  }

  const d = result.data;

  // -- Summary --
  console.log("══════════ SUMMARY ══════════");
  console.log(d.summary || "(empty)");
  console.log();

  // -- Skills --
  console.log("══════════ SKILLS ══════════");
  for (const s of d.skills ?? []) {
    console.log(`  ${s.name}: [${(s.keywords ?? []).join(", ")}]`);
  }
  console.log();

  // -- Experience bullets with trace --
  console.log("══════════ EXPERIENCE ══════════");
  for (const exp of d.experience ?? []) {
    console.log(`\n--- ${exp.id} ---`);
    for (let i = 0; i < exp.bullets.length; i++) {
      const t = exp.bulletTrace?.[i];
      console.log(`  [${i}] ${exp.bullets[i]}`);

      if (t?.claimVerdicts?.length) {
        for (const cv of t.claimVerdicts) {
          if (cv.verdict !== "uncertain") {
            console.log(`       claim: [${cv.type}] "${cv.text}" → ${cv.verdict}${cv.reason ? ` (${cv.reason})` : ""}`);
          }
        }
      }
      if (t?.repairMode && t.repairMode !== "none") {
        console.log(`       repairMode: ${t.repairMode}`);
        if (t.repairs?.length) {
          for (const r of t.repairs) console.log(`       repair: ${r}`);
        }
      }
      if (t?.boundaryVerdict && t.boundaryVerdict !== "pass") {
        console.log(`       boundary: ${t.boundaryVerdict}${t.boundaryReasons?.length ? " — " + t.boundaryReasons.join("; ") : ""}`);
      }
    }
  }

  // -- Positioning plan --
  const plan = d.resumePositioningPlan;
  if (plan) {
    console.log("\n══════════ POSITIONING PLAN ══════════");
    console.log("Target frame:", plan.targetFrame);
    console.log("Candidate thesis:", plan.candidateThesis);
    console.log("Allowed translations:", plan.allowedTranslations?.map((t) => `${t.from} → ${t.to} [${t.claimType}]`).join("; ") || "none");
    console.log("Overclaim risks:", plan.overclaimRisks?.join("; ") || "none");
    console.log("Must-avoid:", plan.mustAvoidConcepts?.join("; ") || "none");
  }

  // -- Verifier trace --
  const rv = d.generationTrace?.repackagingVerifier;
  if (rv) {
    console.log("\n══════════ VERIFIER ══════════");
    console.log("Pitch verdict:", rv.pitchJudge?.verdict);
    console.log("Dominant pitch:", rv.pitchJudge?.dominantPitchDetected);
    console.log("Source pitch dominating:", rv.pitchJudge?.sourcePitchDominating);
    console.log("Failed sections:", rv.pitchJudge?.failedSections?.join(", ") || "none");
    console.log("Softened bullets:", rv.softenedBullets);
    console.log("Dropped bullets:", rv.droppedBullets);
  }

  // -- Bridge judge summary (if available in trace) --
  console.log("\n══════════ GENERATION TRACE ══════════");
  const gt = d.generationTrace;
  console.log("Selected evidence count:", gt.selectedEvidence?.length ?? 0);
  console.log("Content plan experience allocations:", gt.contentPlan?.experienceAllocations?.map((a) => `${a.experienceId}[${a.kind}]`).join(", ") || "none");
  if (gt.densityWarnings?.length) console.log("Density warnings:", gt.densityWarnings.join("; "));

  console.log("\n=== DONE ===");
}

main().catch((e) => {
  console.error("Unhandled error:", e);
  process.exit(1);
});
