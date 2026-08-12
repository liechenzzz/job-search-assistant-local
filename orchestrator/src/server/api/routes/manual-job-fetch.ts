import { JSDOM } from "jsdom";

export type ExtractedJobContent = {
  content: string;
  textLength: number;
  extractionMethod: "static" | "browser";
};

export function extractJobContentFromHtml(
  html: string,
  extractionMethod: "static" | "browser" = "static",
): ExtractedJobContent {
  const dom = new JSDOM(html);
  const document = dom.window.document;

  const pageTitle = document.querySelector("title")?.textContent?.trim() || "";
  const metaDescription =
    document
      .querySelector('meta[name="description"]')
      ?.getAttribute("content")
      ?.trim() || "";
  const ogTitle =
    document
      .querySelector('meta[property="og:title"]')
      ?.getAttribute("content")
      ?.trim() || "";
  const ogDescription =
    document
      .querySelector('meta[property="og:description"]')
      ?.getAttribute("content")
      ?.trim() || "";
  const ogSiteName =
    document
      .querySelector('meta[property="og:site-name"]')
      ?.getAttribute("content")
      ?.trim() || "";

  const elementsToRemove = document.querySelectorAll(
    "script, style, nav, header, footer, aside, iframe, noscript, " +
      '[role="navigation"], [role="banner"], [role="contentinfo"], ' +
      ".nav, .navbar, .header, .footer, .sidebar, .menu, .cookie, .popup, .modal, .ad, .advertisement",
  );
  elementsToRemove.forEach((el) => {
    el.remove();
  });

  const mainContent =
    document.querySelector(
      'main, [role="main"], article, ' +
        ".job-description, .job-details, .job-content, .vacancy-description, " +
        "#job-description, #job-details, #job-content, " +
        '[class*="job-desc"], [class*="jobDesc"], [class*="vacancy"], [class*="posting"], ' +
        '[data-automation-id*="job"], [data-testid*="job"], [aria-label*="Job"]',
    ) || document.body;

  const textContent = cleanExtractedText(mainContent?.textContent || "");
  let enrichedContent = "";
  if (pageTitle) enrichedContent += `Page Title: ${pageTitle}\n`;
  if (ogTitle && ogTitle !== pageTitle) {
    enrichedContent += `Job Title: ${ogTitle}\n`;
  }
  if (ogSiteName) enrichedContent += `Company/Site: ${ogSiteName}\n`;
  if (ogDescription) enrichedContent += `Summary: ${ogDescription}\n`;
  if (metaDescription && metaDescription !== ogDescription) {
    enrichedContent += `Description: ${metaDescription}\n`;
  }
  if (enrichedContent) enrichedContent += "\n---\n\n";
  enrichedContent += textContent;

  if (enrichedContent.length > 50000) {
    enrichedContent = enrichedContent.substring(0, 50000);
  }

  return {
    content: enrichedContent,
    textLength: textContent.length,
    extractionMethod,
  };
}

export function shouldUseRenderedJobFallback(content: string): boolean {
  const text = cleanExtractedText(content).toLowerCase();
  if (text.length < 800) return true;
  const jobSignals = [
    "responsibilities",
    "requirements",
    "qualifications",
    "experience",
    "skills",
    "apply",
    "what you",
    "you will",
  ];
  const signalCount = jobSignals.filter((signal) => text.includes(signal)).length;
  if (signalCount < 2) return true;
  const navigationSignals = ["sign in", "cookie", "privacy policy", "menu"];
  const navigationCount = navigationSignals.filter((signal) =>
    text.includes(signal),
  ).length;
  return navigationCount >= 3 && text.length < 1500;
}

function cleanExtractedText(value: string): string {
  return value
    .replace(/[\t ]+/g, " ")
    .replace(/\n\s*\n/g, "\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function fetchRenderedJobContent(
  url: string,
): Promise<ExtractedJobContent | null> {
  const playwright = await loadPlaywrightChromium();
  if (!playwright) return null;
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    try {
      await page.waitForLoadState("networkidle", { timeout: 5000 });
    } catch {
      // Many ATS pages keep long polling open; DOM content is enough.
    }
    const html = await page.content();
    await page.close();
    return extractJobContentFromHtml(html, "browser");
  } finally {
    await browser.close();
  }
}

async function loadPlaywrightChromium(): Promise<{
  chromium: {
    launch: (options: { headless: boolean }) => Promise<{
      newPage: (options: { userAgent: string }) => Promise<{
        goto: (url: string, options: { waitUntil: string; timeout: number }) => Promise<unknown>;
        waitForLoadState: (state: string, options: { timeout: number }) => Promise<unknown>;
        content: () => Promise<string>;
        close: () => Promise<void>;
      }>;
      close: () => Promise<void>;
    }>;
  };
} | null> {
  try {
    const dynamicImport = new Function("specifier", "return import(specifier)") as (
      specifier: string,
    ) => Promise<{ chromium?: unknown }>;
    const mod = await dynamicImport("playwright");
    if (!mod.chromium) return null;
    return { chromium: mod.chromium } as Awaited<
      ReturnType<typeof loadPlaywrightChromium>
    >;
  } catch {
    return null;
  }
}
