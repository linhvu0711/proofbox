// The trailer the checks script ends a command's stderr with: the memory
// kill counts before and after the command.
export const checksTrailer = (before: number, after: number) =>
  `\n\x1fproofbox-checks ${before} ${after}\n`;

// The trailer the checks script ends with when a Deadline push failed.
export const pushFailedTrailer = (detail: string) =>
  `\n\x1fproofbox-fail ${detail}\n`;
