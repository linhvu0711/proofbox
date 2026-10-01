import { Duration } from "effect";

export const formatTime = (date: Date) =>
  date.toISOString().replace(/\.\d{3}Z$/, "Z");

// A wait as a person reads it, to the nearest second: "2 min", "3 s",
// "2 min 1 s".
export const formatWait = (wait: Duration.Duration) => {
  const seconds = Math.round(Duration.toMillis(wait) / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes === 0) {
    return `${rest} s`;
  }
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
};
