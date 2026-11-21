import type { Size } from "../size.ts";

// The Namespace sizes proofbox offers, and the one a create gets with no
// `--size`. The help text names the defaults, so they live outside the host
// code, which loads only when a command asks for Namespace.
export const LINUX_SIZES: ReadonlyArray<Size> = [
  { cpu: 4, ramGb: 8 },
  { cpu: 8, ramGb: 16 },
  { cpu: 16, ramGb: 32 },
];
export const DEFAULT_LINUX_SIZE: Size = { cpu: 4, ramGb: 8 };

export const MACOS_SIZES: ReadonlyArray<Size> = [
  { cpu: 4, ramGb: 7 },
  { cpu: 6, ramGb: 14 },
];
export const DEFAULT_MACOS_SIZE: Size = { cpu: 4, ramGb: 7 };
