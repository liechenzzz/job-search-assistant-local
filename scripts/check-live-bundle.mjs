const requiredMarkers = [
  "Resume Match ",
  "Strong match",
  "Partial match",
  "Weak match",
  "resumeAlignmentReport",
  "View Word",
  "View HTML",
  "Download Word",
  "Resume page policy",
  "Manual ·",
  "1-page locked · Consulting",
  "2-page locked · City / municipal",
  "Repairing resume from JD + reference evidence",
];
const requiredHealthMarkers = {
  alignmentEngineVersion: "semantic-v4",
  semanticQualificationRules: true,
};

const baseUrl = (process.env.JOB_OPS_URL || "http://localhost:3005").replace(
  /\/$/,
  "",
);

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return response.text();
}

const html = await fetchText(`${baseUrl}/`);
const scriptMatch = html.match(
  /<script[^>]+src=["'](?<src>\/assets\/index-[^"']+\.js)["'][^>]*>/,
);

if (!scriptMatch?.groups?.src) {
  throw new Error(`No Vite index bundle found in ${baseUrl}/`);
}

const bundleUrl = `${baseUrl}${scriptMatch.groups.src}`;
const bundleText = await fetchText(bundleUrl);
const missingMarkers = requiredMarkers.filter(
  (marker) => !bundleText.includes(marker),
);

if (missingMarkers.length > 0) {
  console.error("Frontend bundle stale: missing alignment badge markers.");
  console.error(`URL: ${bundleUrl}`);
  console.error(`Missing: ${missingMarkers.join(", ")}`);
  console.error("Rebuild and restart the job-ops container before testing UI.");
  process.exit(1);
}

const health = JSON.parse(await fetchText(`${baseUrl}/health`));
const staleHealth = Object.entries(requiredHealthMarkers).filter(
  ([key, value]) => health?.[key] !== value,
);

if (staleHealth.length > 0) {
  console.error("Backend container stale: missing semantic alignment markers.");
  console.error(`URL: ${baseUrl}/health`);
  console.error(
    `Expected: ${JSON.stringify(requiredHealthMarkers)}; got: ${JSON.stringify(
      health,
    )}`,
  );
  console.error(
    "Rebuild and restart the job-ops container before testing JD alignment.",
  );
  process.exit(1);
}

console.log("Frontend bundle OK.");
console.log(`URL: ${bundleUrl}`);
console.log("Backend semantic alignment marker OK.");
console.log(`Health: ${baseUrl}/health`);
