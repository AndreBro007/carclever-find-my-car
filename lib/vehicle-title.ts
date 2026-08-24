/**
 * Plain-text vehicle title formatter.
 *
 * Fix for SYS-20260825 (confirmed live, bodyType=Truck search): the
 * result-summary text was built via direct template interpolation
 * (`${id.year} ${id.make} ${id.model}${trimStr}`), so a genuinely
 * missing identity field (e.g. model === null) rendered as the literal
 * word "null" -- e.g. "2027 Ram null Black Express".
 *
 * This is purely a plain-text formatting concern. The canonical
 * structuredContent identity fields (lib/find-matching-vehicle-output.ts
 * IdentitySchema: year/make/model/trim all nullable) are untouched --
 * provider normalization already correctly represents an unknown field
 * as null; this function just never converts that null into display
 * text. Missing components are omitted cleanly, never replaced with a
 * placeholder ("Unknown", "null", "undefined", "[object Object]", etc.)
 * and never fabricated.
 */

export interface VehicleTitleParts {
  year?: number | null;
  make?: string | null;
  model?: string | null;
  trim?: string | null;
}

export function formatVehicleTitle(parts: VehicleTitleParts): string {
  const segments: string[] = [];
  if (parts.year != null) segments.push(String(parts.year));
  if (parts.make) segments.push(parts.make);
  if (parts.model) segments.push(parts.model);
  if (parts.trim) segments.push(parts.trim);
  return segments.join(" ");
}
