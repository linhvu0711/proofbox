// The regions proofbox knows: a fixed stand-in until #49 learns the
// region at login.
export const KNOWN_REGIONS: ReadonlyArray<string> = ["us", "eu"];
export const DEFAULT_REGION = "us";

// A Namespace Sandbox name is `<region>:<instanceId>`: the name carries
// the region the instance was made in, so later calls know which
// regional endpoint to use.
export const hostName = (region: string, instanceId: string) =>
  `${region}:${instanceId}`;

export const splitHostName = (name: string) => {
  const at = name.indexOf(":");
  return at === -1
    ? { region: "", instanceId: name }
    : { region: name.slice(0, at), instanceId: name.slice(at + 1) };
};
