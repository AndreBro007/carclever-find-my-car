/**
 * The note that tells the AI which cars a required hybrid, plug-in or electric search left out (T70, SYS-20261021-024).
 * "Cars that NHTSA shows as a different type than hybrid were left out." gave the AI no way to explain to the buyer why a model it had asked for was missing
 * (an Ioniq 5 in a hybrid search). Models NHTSA shows as another electrified type are now named with that type. Plain gasoline cars are not named: they are the ordinary
 * filler of a base-model search and naming them would only add noise.
 */
const STATE_WORDS: Record<string, string> = { hybrid: "hybrid", mild_hybrid: "mild hybrid", plug_in_hybrid: "plug-in hybrid", electric: "electric" };
const MAX_NAMED = 5;

export function leftOutNote(wantedWords: string, cars: Array<{ model: string; state: string }>): string {
  const seen = new Set<string>();
  const named: string[] = [];
  for (const c of cars) {
    const word = STATE_WORDS[c.state];
    const model = String(c.model ?? "").trim();
    if (!word || !model) continue;
    const label = `${model} (${word})`;
    if (!seen.has(label)) { seen.add(label); named.push(label); }
  }
  const head = `Cars that NHTSA shows as a different type than ${wantedWords} were left out`;
  if (named.length === 0) return `${head}.`;
  const shown = named.slice(0, MAX_NAMED).join(", ");
  return `${head}: ${shown}${named.length > MAX_NAMED ? `, and ${named.length - MAX_NAMED} more` : ""}.`;
}
