import { z } from "zod";
import { CronExpressionParser } from "cron-parser";

function isStandardCron(value) {
  // Exclude seconds, aliases, and nonstandard extensions; let the parser
  // validate field ranges, names, steps, and combinations.
  if (value.trim().split(/\s+/).length !== 5 || !/^[\dA-Za-z*,/\s-]+$/.test(value)) return false;
  if (/[A-Za-z]/.test(value.replace(/JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC|SUN|MON|TUE|WED|THU|FRI|SAT/gi, ""))) return false;
  try {
    CronExpressionParser.parse(value);
    return true;
  } catch {
    return false;
  }
}

const nonEmptyString = z.string().refine((value) => value.trim().length > 0, {
  message: "Must be a non-empty string.",
});

const listSchema = z.strictObject({
  listId: nonEmptyString,
  requestUsername: nonEmptyString,
  autoApproveMovies: z.boolean(),
  autoApproveSeries: z.boolean(),
  enabled: z.boolean(),
});

export const configSchema = z.strictObject({
  scheduleCron: z.string().refine(isStandardCron, {
    message: "Must be a valid standard 5-field cron expression.",
  }),
  runOnStartup: z.boolean(),
  dryRun: z.boolean(),
  seerrUrl: z.url({ protocol: /^https?$/ }),
  seerrApiKey: nonEmptyString,
  mdblistApiKey: nonEmptyString,
  lists: z.array(listSchema).min(1),
});
