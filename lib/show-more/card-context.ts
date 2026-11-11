/** R4-6 step 4b: the card context the search builds once from the request, rebuilt from the STORED requirements so Show 8 more builds the same cards (design sections 5 and 7). */
import { parseIntent } from "../intent-parser";
import type { CardIntentInput } from "../qualifier-accounting";
import type { ConstraintEvidenceRequest } from "../constraint-evidence";
import type { Requirements } from "./requirements";

export interface CardContext { intent: ReturnType<typeof parseIntent>; intentInput: CardIntentInput; evidence: ConstraintEvidenceRequest; relaxedFields: ReadonlySet<string> }

export function cardContextFromRequirements(req: Requirements): CardContext {
  const used = req.condition === "used" ? true : req.condition === "new" ? false : undefined;
  const input = {
    make: req.make, model: req.models?.join(","), priceMin: req.priceMin, priceMax: req.priceMax, yearMin: req.yearMin, yearMax: req.yearMax, mileageMax: req.mileageMax,
    bodyType: req.bodyType, trimRequired: req.trimRequired?.join(", "), drivetrain: req.drivetrain?.join(","), exteriorColor: req.exteriorColors?.join(" "), interiorColor: req.interiorColors?.join(" "),
    doors: req.doors, used, cpo: req.cpo, noAccidents: req.noAccidents, oneOwner: req.oneOwner, electrificationTypes: req.electrificationTypes,
  };
  const intent = parseIntent(input as never);
  const intentInput: CardIntentInput = {
    exteriorColor: input.exteriorColor, interiorColor: input.interiorColor, drivetrain: input.drivetrain, doors: input.doors, used, cpo: req.cpo, noAccidents: req.noAccidents, oneOwner: req.oneOwner,
    seatsMinPreference: intent.semantic.seatsMin, trimRequired: intent.trimRequired,
  };
  const evidence: ConstraintEvidenceRequest = {
    make: intent.hardConstraints.make, model: intent.hardConstraints.model, priceMin: intent.hardConstraints.priceMin, priceMax: intent.hardConstraints.priceMax,
    yearMin: intent.hardConstraints.yearMin, yearMax: intent.hardConstraints.yearMax, mileageMax: intent.hardConstraints.mileageMax, bodyType: intent.hardConstraints.bodyType,
    drivetrain: input.drivetrain, exteriorColor: input.exteriorColor, interiorColor: input.interiorColor, doors: input.doors, used, trimRequired: intent.trimRequired,
    electrified: (req.electrificationTypes?.length ?? 0) > 0, electrificationTypes: req.electrificationRequirement === "required" ? req.electrificationTypes : undefined,
  } as ConstraintEvidenceRequest;
  const relaxed = new Set<string>();
  for (const r of req.relaxations ?? []) {
    if (r === "price") relaxed.add("priceMax");
    if (r === "year") { relaxed.add("yearMin"); relaxed.add("yearMax"); }
    if (r === "mileage") relaxed.add("mileageMax");
    if (r === "trim_close") relaxed.add("trimRequired");
  }
  return { intent, intentInput, evidence, relaxedFields: relaxed };
}
