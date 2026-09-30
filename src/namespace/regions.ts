// The regions proofbox knows: a fixed stand-in until #49 learns the
// region at login.
export const KNOWN_REGIONS: ReadonlyArray<string> = ["us", "eu"];
export const DEFAULT_REGION = "us";

// A Namespace Sandbox name is `<region>:<instanceId>`: each region sees
// only its own instances, so the name carries where to look.
export const hostName = (region: string, instanceId: string) =>
  `${region}:${instanceId}`;

export const splitHostName = (name: string) => {
  const at = name.indexOf(":");
  return at === -1
    ? { region: "", instanceId: name }
    : { region: name.slice(0, at), instanceId: name.slice(at + 1) };
};
