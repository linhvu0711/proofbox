// Bytes as MB with one decimal, as a person reads a size: "2.0".
export const formatMb = (bytes: number): string =>
  (bytes / 1_000_000).toFixed(1);
