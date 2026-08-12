import { describe, expect, it, vi } from "vitest";
import { runOntarioPublicSector } from "../src/run";

function createHtmlResponse(html: string): Response {
  return {
    ok: true,
    status: 200,
    text: async () => html,
  } as Response;
}

describe("runOntarioPublicSector", () => {
  it("discovers relevant official postings from listing and detail pages", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        createHtmlResponse(`
          <a href="/Preview.aspx?JobID=225991">Policy Analyst</a>
          <a href="/Preview.aspx?JobID=225992">Recreation Worker</a>
        `),
      )
      .mockResolvedValueOnce(
        createHtmlResponse(`
          <html>
            <head><title>Policy Analyst | Ontario Public Service</title></head>
            <body>
              <h1>Policy Analyst</h1>
              <p>Location: Toronto, ON</p>
              <p>Salary: $76,000 - $98,000</p>
              <p>Closing Date: June 3, 2026</p>
              <p>Posted: May 20, 2026</p>
              <p>Research, policy analysis, dashboard reporting and evaluation.</p>
            </body>
          </html>
        `),
      );

    const result = await runOntarioPublicSector({
      searchTerms: ["policy analyst"],
      maxJobs: 1,
      fetchImpl: fetchMock,
    });

    expect(result.success).toBe(true);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toEqual(
      expect.objectContaining({
        source: "ontario-public-sector",
        sourceJobId: "ops:225991",
        title: "Policy Analyst",
        employer: "Ontario Public Service",
        location: "Toronto, ON",
        salary: "$76,000 - $98,000",
        deadline: "June 3, 2026",
        datePosted: "May 20, 2026",
      }),
    );
  });

  it("keeps low-value titles out of the scoring queue", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        createHtmlResponse(`
          <a href="/Preview.aspx?JobID=225992">Recreation Data Clerk</a>
        `),
      )
      .mockResolvedValueOnce(
        createHtmlResponse(`
          <h1>Recreation Data Clerk</h1>
          <p>Location: Toronto, ON</p>
          <p>Salary: $20.00 per hour</p>
          <p>Closing Date: June 3, 2026</p>
          <p>Apply now.</p>
          <p>Responsible for attendance data entry and camp program support.</p>
        `),
      );

    const result = await runOntarioPublicSector({
      searchTerms: ["data analyst"],
      maxJobs: 1,
      fetchImpl: fetchMock,
    });

    expect(result.success).toBe(true);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toEqual(
      expect.objectContaining({
        title: "Recreation Data Clerk",
        relevanceStatus: "low_relevance",
        status: "skipped",
      }),
    );
  });

  it("does not let a single broad search term promote weak postings", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        createHtmlResponse(`
          <a href="/Preview.aspx?JobID=225993">Project Manager Parks Construction</a>
        `),
      )
      .mockResolvedValueOnce(
        createHtmlResponse(`
          <h1>Project Manager Parks Construction</h1>
          <p>Location: Toronto, ON</p>
          <p>Salary: $76,000 - $98,000</p>
          <p>Closing Date: June 3, 2026</p>
          <p>Posted: May 20, 2026</p>
          <p>Apply now. This municipal role follows internal policy and procedure.</p>
        `),
      );

    const result = await runOntarioPublicSector({
      searchTerms: ["policy"],
      maxJobs: 1,
      fetchImpl: fetchMock,
    });

    expect(result.success).toBe(true);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toEqual(
      expect.objectContaining({
        title: "Project Manager Parks Construction",
        relevanceStatus: "low_relevance",
        status: "skipped",
      }),
    );
  });

  it("does not turn generic government careers pages into job postings", async () => {
    const genericCareersUrl =
      "https://www.gojobs.gov.on.ca/careers/hiring-process";
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes("Preview.aspx?JobID=225991")) {
        return createHtmlResponse(`
          <html>
            <head><title>Policy Analyst | Ontario Public Service</title></head>
            <body>
              <h1>Policy Analyst</h1>
              <p>Location: Toronto, ON</p>
              <p>Salary: $76,000 - $98,000</p>
              <p>Closing Date: June 3, 2026</p>
              <p>Posted: May 20, 2026</p>
              <p>Apply now for policy analysis and dashboard reporting.</p>
            </body>
          </html>
        `);
      }
      if (url.includes("gojobs.gov.on.ca")) {
        return createHtmlResponse(`
          <a href="${genericCareersUrl}">Policy and data careers</a>
          <a href="/Preview.aspx?JobID=225991">Policy Analyst</a>
        `);
      }
      return createHtmlResponse("");
    });

    const result = await runOntarioPublicSector({
      searchTerms: ["policy analyst"],
      maxJobs: 1,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.success).toBe(true);
    expect(result.jobs).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalledWith(
      genericCareersUrl,
      expect.anything(),
    );
  });

  it("discovers PolicyJobsOTT newsletter postings from the Substack feed", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      createHtmlResponse(`
        <rss><channel>
          <item>
            <title><![CDATA[PolicyJobs OTT #57]]></title>
            <link>https://policyjobsott.substack.com/p/policyjobs-ott-57</link>
            <pubDate>Fri, 15 May 2026 12:40:48 GMT</pubDate>
            <content:encoded><![CDATA[
              <h2>the jobs</h2>
              <h4>1. <a href="https://example.org/jobs/policy-analyst">Policy Analyst — Example Institute</a></h4>
              <p>This role conducts policy research, data analysis, dashboards, and evaluation.</p>
              <p>Salary: $80,000 - $95,000</p>
              <h4></h4>
            ]]></content:encoded>
          </item>
        </channel></rss>
      `),
    );

    const result = await runOntarioPublicSector({
      searchTerms: ["policy analyst"],
      maxJobs: 5,
      selectedSources: ["policyjobs-ottawa"],
      fetchImpl: fetchMock,
    });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toEqual(
      expect.objectContaining({
        source: "policyjobs-ottawa",
        title: "Policy Analyst — Example Institute",
        employer: "Example Institute",
        jobUrl: "https://example.org/jobs/policy-analyst",
        location: "Ottawa, ON",
        salary: "$80,000 - $95,000",
        datePosted: "Fri, 15 May 2026 12:40:48 GMT",
      }),
    );
    expect(result.jobs[0]?.locationEvidence?.sourceNotes).toEqual(
      expect.arrayContaining([
        "source:policyjobs-ottawa",
        "edition:PolicyJobs OTT #57",
      ]),
    );
  });

  it("extracts Barrie embedded jobs without treating the search shell as a posting", async () => {
    const barrieSearchUrl = "https://careers.barrie.ca/search/";
    const barrieDetailUrl =
      "https://careers.barrie.ca/policy-data-analyst-CA-123456-en";
    const fetchMock = vi.fn(async (url: string) => {
      if (url === barrieSearchUrl) {
        return createHtmlResponse(`
          <astro-island props="{&quot;jobs&quot;:[1,[
            [0,{
              &quot;path&quot;:[0,&quot;/recreation-worker-CA-111111-en&quot;],
              &quot;context&quot;:[0,{
                &quot;applicationFormUrl&quot;:[0,&quot;https://barrie.hiringplatform.ca/111111-recreation/1/en&quot;],
                &quot;postingDate&quot;:[0,&quot;Tue, 01 Jan 2026 12:00:00 UTC&quot;],
                &quot;title&quot;:[0,&quot;Recreation Data Clerk&quot;],
                &quot;description&quot;:[0,&quot;<p>Posting Number: RC-26-01</p><p>Job Type: Part-time</p><p>Salary Range: $20.00 per hour</p><p>Closing Date: June 1, 2026</p><p>Supports recreation attendance data.</p>&quot;]
              }]
            }],
            [0,{
              &quot;path&quot;:[0,&quot;/policy-data-analyst-CA-123456-en&quot;],
              &quot;context&quot;:[0,{
                &quot;applicationFormUrl&quot;:[0,&quot;https://barrie.hiringplatform.ca/123456-policy-data-analyst/1/en&quot;],
                &quot;postingDate&quot;:[0,&quot;Wed, 02 Jan 2026 12:00:00 UTC&quot;],
                &quot;title&quot;:[0,&quot;Policy Data Analyst&quot;],
                &quot;description&quot;:[0,&quot;<p>Posting Number: PA-26-01</p><p>Job Type: Full-time</p><p>Location: Barrie, ON</p><p>Salary Range: $80,000 - $95,000</p><p>Closing Date: June 5, 2026</p><p>Leads policy research, data analysis, dashboards, and performance measurement.</p>&quot;]
              }]
            }]
          ]]}"></astro-island>
        `);
      }
      return createHtmlResponse("");
    });

    const result = await runOntarioPublicSector({
      searchTerms: ["policy data analyst"],
      maxJobs: 5,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.success).toBe(true);
    expect(result.jobs).toHaveLength(2);
    expect(
      result.jobs.find((job) => job.title === "Recreation Data Clerk"),
    ).toEqual(
      expect.objectContaining({
        relevanceStatus: "low_relevance",
        status: "skipped",
      }),
    );
    expect(result.jobs.find((job) => job.title === "Policy Data Analyst")).toEqual(
      expect.objectContaining({
        source: "ontario-public-sector",
        sourceJobId: "barrie:policy-data-analyst-CA-123456-en",
        title: "Policy Data Analyst",
        employer: "City of Barrie",
        jobUrl: barrieDetailUrl,
        applicationLink:
          "https://barrie.hiringplatform.ca/123456-policy-data-analyst/1/en",
        location: "Barrie, ON",
        salary: "$80,000 - $95,000",
        deadline: "June 5, 2026",
      }),
    );
    expect(fetchMock).not.toHaveBeenCalledWith(
      barrieDetailUrl,
      expect.anything(),
    );
  });

  it("follows SuccessFactors category pages when the landing page has no direct job links", async () => {
    const kitchenerHomeUrl = "https://jobs.kitchener.ca/";
    const categoryUrl =
      "https://jobs.kitchener.ca/go/Corporate-services/2698817/";
    const detailUrl =
      "https://jobs.kitchener.ca/job/Kitchener-Policy-Data-Analyst-ON/123456789/";
    const fetchMock = vi.fn(async (url: string) => {
      if (url === kitchenerHomeUrl) {
        return createHtmlResponse(`
          <a href="/go/Corporate-services/2698817/">Corporate services</a>
        `);
      }
      if (url === categoryUrl) {
        return createHtmlResponse(`
          <a class="jobTitle-link" href="/job/Kitchener-Policy-Data-Analyst-ON/123456789/">Policy Data Analyst</a>
        `);
      }
      if (url === detailUrl) {
        return createHtmlResponse(`
          <h1>Policy Data Analyst</h1>
          <p>Location: Kitchener, ON</p>
          <p>Salary: $82,000 - $97,000</p>
          <p>Closing Date: June 9, 2026</p>
          <p>Posted: May 25, 2026</p>
          <p>Apply now. Leads policy research, data analysis, dashboards, and evaluation.</p>
        `);
      }
      return createHtmlResponse("");
    });

    const result = await runOntarioPublicSector({
      searchTerms: ["policy data analyst"],
      maxJobs: 1,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.success).toBe(true);
    expect(result.jobs).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(categoryUrl, expect.anything());
    expect(result.jobs[0]).toEqual(
      expect.objectContaining({
        sourceJobId: "kitchener:123456789",
        title: "Policy Data Analyst",
        employer: "City of Kitchener",
        jobUrl: detailUrl,
        location: "Kitchener, ON",
      }),
    );
  });
});
