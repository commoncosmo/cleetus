/** Render the staged-image count for display near the input, or null when nothing is staged. */
export function stagedIndicator(n: number): string | null {
  if (n <= 0) return null;
  const noun = n === 1 ? "image" : "images";
  return `📎 ${n} ${noun} attached — /image clear to reset`;
}
