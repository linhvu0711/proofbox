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

export const formatElapsed = (elapsed: Duration.Duration) => {
  const seconds = Math.floor(Duration.toMillis(elapsed) / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes === 0) return `${rest}s`;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
};

// A local clock time a person reads: "14:05" today, "2026-10-06 01:30" on
// another day. Cut to the minute, never rounded up.
export const formatClock = (date: Date, now: Date) => {
  const two = (n: number) => String(n).padStart(2, "0");
  const time = `${two(date.getHours())}:${two(date.getMinutes())}`;
  const day = (d: Date) =>
    `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
  return day(date) === day(now) ? time : `${day(date)} ${time}`;
};
