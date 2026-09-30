/** Splits `items` into groups of at most `size`: chunk([1,2,3,4,5], 2) → [[1,2],[3,4],[5]]. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error(`chunk size must be a positive integer, got ${size}`);
  const groups: T[][] = [];
  for (let i = 0; i < items.length; i += size) groups.push(items.slice(i, i + size));
  return groups;
}

/** Removes duplicates, keeping the first occurrence. */
export function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}
