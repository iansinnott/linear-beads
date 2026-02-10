/**
 * Structured logging helper
 *
 * No internal dependencies — imported by every other module.
 */

export function log(
  level: "info" | "warn" | "error",
  message: string,
  data?: Record<string, unknown>
): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...data,
  };
  if (level === "error") {
    console.error(JSON.stringify(entry));
  } else if (level === "warn") {
    console.warn(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}
