import { stripHtml } from "@/lib/utils";

export const getRenderableJobDescription = (jobDescription?: string | null) => {
  if (!jobDescription) return "No description available.";

  const plainText =
    jobDescription.includes("<") && jobDescription.includes(">")
      ? stripHtml(jobDescription)
      : jobDescription;

  const normalizedLineBreaks = plainText.replace(/\r\n/g, "\n");
  if (
    normalizedLineBreaks.includes("\\n") &&
    !normalizedLineBreaks.includes("\n")
  ) {
    return normalizedLineBreaks.replace(/\\n/g, "\n");
  }

  return normalizedLineBreaks;
};
