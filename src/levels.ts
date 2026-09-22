/** Thinking levels managed by the router. Pi's full set also has off/minimal/max — we never emit those. */
export const ROUTED_LEVELS = ["low", "medium", "high", "xhigh"] as const;
export type RoutedLevel = (typeof ROUTED_LEVELS)[number];

/** Pi's thinking-level type (subset of what setThinkingLevel accepts). */
export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export function isRoutedLevel(v: unknown): v is RoutedLevel {
  return typeof v === "string" && (ROUTED_LEVELS as readonly string[]).includes(v);
}

/** Parse a Jev answer into a routed level; returns null for anything invalid. */
export function parseLevel(v: unknown): RoutedLevel | null {
  if (typeof v !== "string") return null;
  const norm = v.trim().toLowerCase();
  return isRoutedLevel(norm) ? norm : null;
}

export function levelIndex(l: RoutedLevel): number {
  return ROUTED_LEVELS.indexOf(l);
}

/**
 * Fold any pi thinking level into the routed space.
 * off/minimal are treated as the floor ("low"); max is treated as the ceiling ("xhigh").
 */
export function foldLevel(l: ThinkingLevel): RoutedLevel {
  if (isRoutedLevel(l)) return l;
  if (l === "off" || l === "minimal") return "low";
  return "xhigh"; // "max"
}
