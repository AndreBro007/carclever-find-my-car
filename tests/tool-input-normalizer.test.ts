import test from "node:test";
import assert from "node:assert/strict";
import { normalizeToolArguments, invalidFieldsFromError, ignoredInputsNote, addNoteToMcpResponseText } from "../lib/tool-input-normalizer";

test("tool input is repaired, not rejected: null dropped, text numbers fixed, lists and text swapped, unknown fields dropped", () => {
  const r = normalizeToolArguments("find_matching_vehicle", { bodyType: "SUV", zip: null, priceMax: "$45,000", yearMin: "2020", used: "true", model: ["Telluride", "Palisade"], vehicleNeeds: "family SUV", electrificationTypes: "hybrid, electric", minSeats: 7, radiusMiles: "50" });
  assert.deepEqual(r.args, { bodyType: "SUV", priceMax: 45000, yearMin: 2020, used: true, model: "Telluride, Palisade", vehicleNeeds: ["family SUV"], electrificationTypes: ["hybrid", "electric"], radiusMiles: 50 });
  assert.ok(r.changes.some((c) => c.includes("dropped unknown field minSeats")) && r.changes.some((c) => c.includes("dropped empty zip")));
  assert.equal(normalizeToolArguments("find_matching_vehicle", { priceMax: "45k" }).args.priceMax, 45000);
  assert.equal(normalizeToolArguments("find_matching_vehicle", { zip: 9622 }).args.zip, "09622");
  const cheap = normalizeToolArguments("find_matching_vehicle", { priceMax: "cheap" });
  assert.equal(cheap.args.priceMax, undefined); assert.ok(cheap.ignored.some((x) => x.startsWith("priceMax")));
  assert.deepEqual(normalizeToolArguments("resolve_dealer_url", { vin: "1HGCM82633A004352", year: "2014", extra: 1 }).args, { vin: "1HGCM82633A004352", year: 2014 });
  assert.deepEqual(normalizeToolArguments("compare_vehicles", { vins: "AAA BBB, CCC" }).args, { vins: ["AAA", "BBB", "CCC"] });
  const untouched = { anything: null };
  assert.deepEqual(normalizeToolArguments("some_other_tool", untouched).args, untouched);
  assert.deepEqual(normalizeToolArguments("find_matching_vehicle", { make: "Honda", model: "Civic", priceMax: 30000 }).changes, []);
});

test("fixed-choice values: empty ones dropped quietly, wrong case fixed, invented ones set aside and reported", () => {
  const empties = normalizeToolArguments("find_matching_vehicle", { bodyType: "SUV", priorityAxis: "", priceFlexibility: "  ", transmission: "", electrificationRequirement: "" });
  assert.deepEqual(empties.args, { bodyType: "SUV" }); assert.deepEqual(empties.ignored, []);
  const fixed = normalizeToolArguments("find_matching_vehicle", { priorityAxis: "Best for budget", priceFlexibility: "Strict", transmission: "automatic", electrificationTypes: ["Plug-in hybrid", "EV"], electrificationRequirement: "Preferred" });
  assert.deepEqual(fixed.args, { priorityAxis: "best_for_budget", priceFlexibility: "strict", transmission: "Automatic", electrificationTypes: ["plug_in_hybrid", "electric"], electrificationRequirement: "preferred" });
  assert.deepEqual(fixed.ignored, []);
  const invented = normalizeToolArguments("find_matching_vehicle", { priorityAxis: "best_value", transmission: "Any", radiusMiles: "Any", electrificationRequirement: "required" });
  assert.deepEqual(invented.args, {});
  assert.ok(["priorityAxis", "transmission", "radiusMiles", "electrificationRequirement"].every((f) => invented.ignored.some((x) => x.startsWith(f))));
});

test("validation error text names the fields to set aside; the note goes in front of the reply in both response shapes", () => {
  assert.deepEqual(invalidFieldsFromError("find_matching_vehicle", "Input validation error: Invalid arguments for tool find_matching_vehicle: priceFlexibility: Invalid input, priorityAxis: Invalid input, electrificationTypes.0: Invalid input").sort(), ["electrificationTypes", "priceFlexibility", "priorityAxis"]);
  assert.deepEqual(invalidFieldsFromError("check_vehicle", "year: Invalid input"), ["year"]);
  assert.deepEqual(invalidFieldsFromError("find_matching_vehicle", "nothing relevant"), []);
  const note = ignoredInputsNote(["priorityAxis (value not accepted)"]);
  assert.match(note, /^Note: these inputs could not be used and were ignored: priorityAxis \(value not accepted\)\. The results below do not reflect them\.$/);
  const sse = 'event: message\ndata: {"result":{"content":[{"type":"text","text":"Found 5 cars"}]},"jsonrpc":"2.0","id":1}\n\n';
  assert.match(addNoteToMcpResponseText(sse, note), /"text":"Note: these inputs could not be used[^"]*\\n\\nFound 5 cars"/);
  assert.match(JSON.parse(addNoteToMcpResponseText('{"result":{"content":[{"type":"text","text":"x"}]}}', note)).result.content[0].text, /^Note: these inputs[\s\S]*\n\nx$/);
  assert.equal(addNoteToMcpResponseText(sse, ""), sse);
});
