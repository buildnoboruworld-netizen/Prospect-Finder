// Stage 2 — breadth. Run the query plan and assemble candidates cheaply; the
// depth happens in qualify. The excluded ledger written here is what makes the
// shortfall report at the end honest rather than a shrug.

import type { StageIO } from "../contracts";
import {
  clamp,
  exclusionBlock,
  fieldLines,
  icpBlock,
  joinSections,
  numberedList,
  orderedUnique,
  section,
} from "./render";
import { buildSystemPrompt, type PromptOptions, type StagePrompt } from "./system";

const BRIEF = `# Stage 2 of 4 — discovery

Work through the query plan below and assemble 30 to 50 candidate brands worth a deep dive. Breadth now, depth later: one line of evidence and one retrieved URL per brand is enough, and the next stage does the real digging. Spending the search budget on the first five brands is the main way this stage fails.

For each candidate, record the brand's name as it writes it, its own website domain if it has one, its Instagram handle, the city it operates from, one line on why it looks like a fit, and at least one URL you actually opened. A brand with no retrievable page is not a candidate — log it as excluded instead.

Deliberately keep the brands that look weak online. An Instagram-only brand with a dead website is the best prospect in this system, not the worst; a brand with a polished, well-ranked content operation is the worst. Do not drift towards whichever brands look most successful.

Spread your sources. A listicle of twenty brands is one discovery, not twenty — cross-check it and keep hunting on other surfaces. A brand you can see from two directions, its own site plus an independent mention, is worth more than two you can only see from one.

Merge duplicates inside your own list: the same brand written with and without "Foods", "India" or "Co.", or under a different transliteration, is one candidate.

Log every brand you considered and rejected, with a reason:
- too_big — a household name, national FMCG, funded at Series A or beyond, or otherwise past this ICP.
- duplicate — matches a name, domain or handle on the exclusion list. Those are the brands the team already holds plus the ones the admin ruled out, so this is the reason most exclusions get.
- rejected — the team explicitly rejected it earlier. You will rarely be able to tell; prefer duplicate when unsure.
- off_icp — not an independent Indian D2C brand: reseller, marketplace, aggregator, agency, service business, B2B-only distributor, foreign brand, or one that has clearly stopped trading.
- no_source — you have a name but could not retrieve any page for it.

That log is the only trace of the work you did not keep, and the run's honesty report is built from it. A brand you drop silently is invisible. The exclusion list is also enforced again downstream, so a wrong call there is caught — pick the closest reason and move on rather than agonising.

If the plan runs dry before 30 candidates, stop and let the log explain it. Do not loosen the criteria and do not add brands from memory to reach the number.`;

export function buildDiscoverPrompt(
  input: StageIO["discover"]["input"],
  opts: PromptOptions
): StagePrompt {
  const { plan } = input;

  const context = joinSections([
    section("Query plan — run these in order", numberedList(orderedUnique(plan.queries))),
    icpBlock(plan),
    section("Exclusions", exclusionBlock(plan)),
    section(
      "Run context",
      fieldLines({
        "Leads this run ultimately needs": plan.targetLeads,
        "Candidates to gather now": "30–50 (over-supply is expected; qualification thins it)",
        "Planner notes": clamp(plan.notes, 800),
      })
    ),
  ]);

  return {
    system: buildSystemPrompt(opts),
    messages: [{ role: "user", content: `${BRIEF}\n\n${context}` }],
  };
}
