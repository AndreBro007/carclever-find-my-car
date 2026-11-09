/**
 * Group 2, item 6 (9 Nov 2026): the recall campaign summaries are clipped to 240 characters (lib/nhtsa-recalls-client.ts, clipRecallText) and NHTSA writes them as long lists of models,
 * so the clipped text can end before the car's own model ("Camry" in case 22). One extra line states which car the campaigns are listed for. NHTSA's recall lookup is queried by make,
 * model and model year (recallsByVehicle), so the statement is true by construction; it also says plainly that the list is by model year, not this specific car.
 * The "Recall details (NHTSA, N total...)" line itself is NOT changed: usage events recognise that exact text.
 */
export function recallApplicabilityLine(year: unknown, make: unknown, model: unknown): string | null {
  const y = String(year ?? "").trim(), mk = String(make ?? "").trim(), md = String(model ?? "").trim();
  if (!y || !mk || !md) return null;
  return `These campaigns are listed by NHTSA for the ${y} ${mk} ${md} (model year, not this specific car).`;
}
