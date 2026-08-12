import { describe, expect, it } from "vitest";
import { classifyJobRelevance } from "./job-relevance";

describe("classifyJobRelevance", () => {
  it("hard discards public-sector career landing pages even when they mention applying", () => {
    expect(
      classifyJobRelevance({
        source: "ontario-public-sector",
        sourceKind: "public-sector",
        title: "Careers at City of Hamilton",
        employer: "City of Hamilton",
        location: "Hamilton, ON",
        description: "Search current opportunities and apply online.",
        url: "https://cityofhamilton.bamboohr.com/careers",
      }),
    ).toMatchObject({
      status: "non_job_page",
    });
  });

  it("hard discards public-sector information pages with incidental salary or policy text", () => {
    expect(
      classifyJobRelevance({
        source: "ontario-public-sector",
        sourceKind: "public-sector",
        title: "Access your file with MyBenefits",
        employer: "City of Hamilton",
        description:
          "Apply and report. Jobs at the City. Frequently Requested By-laws. Policy and Fair Wage Schedule.",
        salary: "Policy and Fair Wage Schedule",
        url: "https://www.hamilton.ca/people-programs/financial-stability-supports/ontario-works/access-your-file-mybenefits",
      }),
    ).toMatchObject({
      status: "non_job_page",
    });

    expect(
      classifyJobRelevance({
        source: "ontario-public-sector",
        sourceKind: "public-sector",
        title: "Internationally Trained Professionals",
        employer: "York Region",
        description: "Join our team. Search. Health. Parenting. Nutrition.",
        url: "https://www.york.ca/york-region/careers/internationally-trained-professionals",
      }),
    ).toMatchObject({
      status: "non_job_page",
    });
  });

  it("keeps strong policy/data postings as high matches", () => {
    expect(
      classifyJobRelevance({
        source: "ontario-public-sector",
        sourceKind: "public-sector",
        title: "Policy Data Analyst",
        employer: "City of Hamilton",
        location: "Hamilton, ON",
        description:
          "Policy Data Analyst Job Details | City of Hamilton. Policy research, data analysis, evaluation, SQL dashboards, and stakeholder reporting.",
        url: "https://jobs.hamilton.ca/job/Hamilton-Policy-Data-Analyst-ON-L8P-4Y5/602377317/",
      }),
    ).toMatchObject({
      status: "high_match",
    });
  });

  it("keeps ATS job pages with navigation shell text while classifying low-value roles", () => {
    expect(
      classifyJobRelevance({
        source: "ontario-public-sector",
        sourceKind: "public-sector",
        title: "GIS Data and Analytics Analyst",
        employer: "City of Richmond Hill",
        description:
          "GIS Data and Analytics Analyst Job Details | Richmond Hill. Skip to main content. Current Openings. Working for Richmond Hill.",
        url: "https://jobs.richmondhill.ca/job/Richmond-Hill-GIS-Data-and-Analytics-Analyst-ON-L4B-3P4/602377317/",
      }),
    ).toMatchObject({
      status: "high_match",
    });

    expect(
      classifyJobRelevance({
        source: "ontario-public-sector",
        sourceKind: "public-sector",
        title: "Usher",
        employer: "City of Richmond Hill",
        description:
          "Usher Job Details | Richmond Hill. Skip to main content. Current Openings.",
        url: "https://jobs.richmondhill.ca/job/Richmond-Hill-Usher-ON-L4B-3P4/599234017/",
      }),
    ).toMatchObject({
      status: "low_relevance",
    });
  });

  it("hard discards municipal content pages that lack posting evidence", () => {
    expect(
      classifyJobRelevance({
        source: "ontario-public-sector",
        sourceKind: "public-sector",
        title: "Backyard Composting",
        employer: "City of Hamilton",
        description:
          "Backyard Composting | City of Hamilton. Skip to main content. I Want To. Search. Green bin and composting information.",
        url: "https://www.hamilton.ca/home-neighbourhood/garbage-recycling/green-bin-composting/backyard-composting",
      }),
    ).toMatchObject({
      status: "non_job_page",
    });

    expect(
      classifyJobRelevance({
        source: "ontario-public-sector",
        sourceKind: "public-sector",
        title: "Visual Health",
        employer: "City of Hamilton",
        description:
          "Visual Health | City of Hamilton. Children should have one eye covered during screening.",
        deadline: "one eye",
        url: "https://www.hamilton.ca/people-programs/public-health/visual-health",
      }),
    ).toMatchObject({
      status: "non_job_page",
    });
  });
});
