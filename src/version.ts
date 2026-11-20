// scripts/build.ts defines PROOFBOX_COMMIT as the short commit it built from
// (ADR 0017). Run from src/, it is not defined.
declare const PROOFBOX_COMMIT: string | undefined;

const VERSION = "0.0.0";

export const versionText = () =>
  typeof PROOFBOX_COMMIT === "string"
    ? `${VERSION} (${PROOFBOX_COMMIT})`
    : VERSION;
