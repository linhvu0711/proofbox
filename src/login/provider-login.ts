import { Config } from "effect";

export const envTokenName = (provider: string) =>
  `PROOFBOX_${provider.toUpperCase()}_TOKEN`;

export const envToken = (provider: string) =>
  Config.option(Config.redacted(envTokenName(provider)));
