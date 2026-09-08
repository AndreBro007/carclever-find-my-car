# Probe Description Change Log — model-list resolution wording

Tracks every iteration of the practical-need → model-list wording, so any
single change can be reverted independently without a full Git revert.

## v4 (baseline, before this whole investigation)
Main description: no mention of model resolution beyond generic practical-needs sentence.
`model` field: no description at all (bare field).
`vehicleNeeds` field: no description at all (bare field).

## v5 (commit 0e0dc38) — abstract principle, main description only
Added to main description: "When a practical need points to specific vehicle
types, the calling assistant identifies likely matching models and includes
them alongside the stated need."
Result: FAILED on ChatGPT (no model list produced).

## v6 first attempt (commit 6d2e29f) — field-level descriptions added
All fields given descriptions for the first time. `model` field: "...When a
practical need implies specific vehicle types, likely matching models are
included here alongside the related need stated in vehicleNeeds."
`vehicleNeeds` field: mirrored, passive voice.
Result: FAILED on ChatGPT (no model list produced).

## v6 second attempt (commits e0a4e05 broken / 01cea39 fixed) — concrete examples
Main description sentence rewritten with worked examples: "...the calling
assistant resolves it into real matching model names and includes them in
model (for example, a large family SUV might include CR-V, RAV4, or
Highlander; a reliable commuter car might include Corolla, Civic, or
Mazda3), alongside the related need stated in vehicleNeeds."
`model` field and `vehicleNeeds` field updated to match with same examples.
Result: WORKED on ChatGPT for model-list population (3/3 test prompts) —
but surfaced a NEW bug: manufacturer names were included (e.g. "Honda CR-V"
instead of "CR-V"), which silently returns zero real results.

## v7 (commit 4ad8453) — manufacturer-name fix + priorityAxis fix
`model` field description added: "This applies even in a cross-brand list:
'CR-V, RAV4, Outback' is correct; 'Honda CR-V, Toyota RAV4, Subaru Outback'
is not."
`priorityAxis` field description added V1's budget-vs-cheapest disambiguation
(separate, unrelated fix, confirmed working correctly — not part of this
model-list investigation, no need to revert this half if v8 doesn't work).
Result: model field STOPPED populating almost entirely in subsequent tests
on both ChatGPT and Claude (regression from v6-second-attempt's success rate).

## v8 (this change) — imperative voice, matching V1's actual working pattern
Root cause hypothesis: v5/v6/v7 all used PASSIVE/DECLARATIVE voice
("...are resolved and included here", "...the calling assistant resolves
it..." as a descriptive statement). V1's real, historically-working
description used direct second-person IMPERATIVE commands, stated twice
(main description + field description), e.g. "resolve it into a real,
comma-separated model list... every time" and "resolve it into real model
names here, using your own knowledge, before calling this tool."
This is the first attempt to test imperative voice specifically, isolated
as its own variable from the examples/manufacturer-name content (which are
kept, since those were separately confirmed-correct content, not the
suspected cause of the regression).

### Exact text changes in v8:

**Main description sentence** — changed from:
  "When a practical need implies a vehicle class, the calling assistant
  resolves it into real matching model names and includes them in model
  (for example, a large family SUV might include CR-V, RAV4, or Highlander;
  a reliable commuter car might include Corolla, Civic, or Mazda3),
  alongside the related need stated in vehicleNeeds."
to:
  "When a practical need implies a vehicle class, resolve it into real
  matching model names yourself and include them in model before calling
  this tool (for example, a large family SUV might include CR-V, RAV4, or
  Highlander; a reliable commuter car might include Corolla, Civic, or
  Mazda3), every time, alongside the related need stated in vehicleNeeds."

**`model` field description** — changed from:
  "...When a practical need implies a vehicle class (for example, a large
  family SUV, or a reliable commuter car), likely matching real model names
  are resolved and included here (for example, CR-V, RAV4, Highlander for a
  family SUV) alongside the related need stated in vehicleNeeds."
to:
  "...When a practical need implies a vehicle class (for example, a large
  family SUV, or a reliable commuter car), resolve it into real matching
  model names yourself, using your own knowledge, before calling this tool
  (for example, CR-V, RAV4, Highlander for a family SUV), every time,
  alongside the related need stated in vehicleNeeds."

**`vehicleNeeds` field description** — changed from:
  "...When a listed need implies a vehicle class, likely matching real model
  names are resolved and included in `model` alongside it (for example, a
  large family SUV need pairs with a model list like CR-V, RAV4, Highlander)."
to:
  "...When a listed need implies a vehicle class, also resolve it into real
  matching model names yourself and include them in `model` alongside it
  (for example, a large family SUV need pairs with a model list like CR-V,
  RAV4, Highlander)."

### To revert v8 only (keep v7's manufacturer-name + priorityAxis fixes):
Replace the three strings above back to their v7 (passive-voice) versions.
Everything else in the file is unchanged from v7.

### To revert to v7 fully:
Same as above — v8 only touches these three description strings, nothing
else changed (no schema shape changes, no new fields, no removed fields).
