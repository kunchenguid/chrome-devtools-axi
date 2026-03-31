export interface RefInfo {
  ref: string;
  label: string;
  type: string;
}

/** Count interactive refs (uid=...) in snapshot text. */
export function countRefs(snapshot: string): number {
  const matches = snapshot.match(/\buid=\S+/g);
  return matches ? matches.length : 0;
}

/** Extract ref IDs with labels and types from snapshot text. */
export function extractRefs(snapshot: string): RefInfo[] {
  const refs: RefInfo[] = [];
  for (const line of snapshot.split("\n")) {
    const m = line.match(/\buid=(\S+)\s+(\w+)\s+"([^"]*)"/);
    if (!m) continue;
    refs.push({ ref: m[1], type: m[2], label: m[3] });
  }
  return refs;
}

/** Extract page title from snapshot (RootWebArea or first heading). */
export function extractTitle(snapshot: string): string {
  const rootMatch = snapshot.match(/RootWebArea\s+"([^"]+)"/);
  if (rootMatch) return rootMatch[1];
  const headingMatch = snapshot.match(/\bheading\s+"([^"]+)"/);
  if (headingMatch) return headingMatch[1];
  return "";
}

export interface TruncationResult {
  text: string;
  truncated: boolean;
  totalLength: number;
}

export function truncateSnapshot(
  snapshot: string,
  full: boolean,
  limit = 16000,
): TruncationResult {
  const totalLength = snapshot.length;
  if (full || totalLength <= limit) {
    return { text: snapshot, truncated: false, totalLength };
  }
  const cut = snapshot.lastIndexOf("\n", limit);
  const text = cut > 0 ? snapshot.slice(0, cut) : snapshot.slice(0, limit);
  return { text, truncated: true, totalLength };
}

/**
 * Truncate arbitrary text keeping both head and tail so recent/trailing data is preserved.
 * Used for eval output where the end of the result is often as important as the beginning.
 */
const MARKER_OVERHEAD = 50;

export function truncateText(text: string, limit = 8000): TruncationResult {
  const totalLength = text.length;
  if (totalLength <= limit) {
    return { text, truncated: false, totalLength };
  }
  // The omission marker adds overhead; skip truncation when
  // the text is short enough that truncating would produce a longer result.
  if (totalLength <= limit + MARKER_OVERHEAD) {
    return { text, truncated: false, totalLength };
  }
  const headBudget = Math.floor(limit * 0.4);
  const tailBudget = limit - headBudget;
  // Cut at line boundaries when possible
  const headCut = text.lastIndexOf("\n", headBudget);
  const head = headCut > 0 ? text.slice(0, headCut) : text.slice(0, headBudget);
  const tailStart = text.indexOf("\n", totalLength - tailBudget);
  const tail =
    tailStart > 0 && tailStart < totalLength
      ? text.slice(tailStart + 1)
      : text.slice(totalLength - tailBudget);
  const omitted = totalLength - head.length - tail.length;
  const result = `${head}\n\n... (${omitted} chars omitted, ${totalLength} total) ...\n\n${tail}`;
  return { text: result, truncated: true, totalLength };
}

const INPUT_TYPES = ["textbox", "searchbox", "input", "combobox", "textarea"];

/** Check if a ref type is an input/form field. */
export function isInputType(type: string): boolean {
  return INPUT_TYPES.includes(type);
}
