export const formatTime = (date: Date) =>
  date.toISOString().replace(/\.\d{3}Z$/, "Z");
