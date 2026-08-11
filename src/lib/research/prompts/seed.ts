// Stage 1 — turn an industry's ICP config into a concrete India-focused query
// plan. No candidates are expected here; planning badly is cheap, discovering
// badly is not.

import type { StageIO } from "../contracts";
import {
  bulletList,
  clamp,
  fieldLines,
  joinSections,
  numberedList,
  orderedUnique,
  section,
  sortedUnique,
} from "./render";
import { buildSystemPrompt, type PromptOptions, type StagePrompt } from "./system";

// Everything variable is appended after this block, so the cacheable prefix is
// as long as possible. Same structure in all four stages.
const BRIEF = `# Stage 1 of 4 — search plan

Turn this industry's ICP into an ordered list of search queries that a careful human researcher would actually type to find small Indian D2C brands in it. You are planning, not discovering: no brand names are expected from this stage.

Write 8 to 16 queries, best first — the run may not get through all of them. Each query must plausibly return a different result set from its neighbours; near-duplicates burn the search budget for nothing.

Cover several discovery surfaces, because each one is biased differently:
- Category + India + a size or recency qualifier ("new", "small batch", "founded 2023", "startup"), so the results are not simply the category's giants.
- Indian startup press and roundups — yourstory.com, inc42.com, entrackr.com, indianretailer.com, the Economic Times retail desk — reached with site: queries.
- Shark Tank India pitches, by season. Brands that aired without taking a deal fit this ICP unusually well: real traction, national attention, no war chest.
- Small-end funding news: angel, pre-seed and seed rounds. Series A and beyond is usually already too big for us.
- Marketplace and social surfaces — Amazon.in brand stores, Nykaa or Flipkart new-brand listings, Instagram. The brands with the widest discovery gap are exactly the ones a plain Google search will not surface, so a query plan made only of Google-shaped queries will systematically miss the best prospects.
- City and regional clusters (Bengaluru, Mumbai, Delhi NCR, Jaipur, Ahmedabad, Coimbatore, Indore, Kochi…). National lists skip regional brands, and regional brands are under-served and easier to win.
- "Alternatives to <excluded brand>" and "<excluded brand> competitors". This shape reliably surfaces the small players in a category one giant dominates — use the exclusion list as fuel, not only as a filter.
- Award shortlists, accelerator cohorts and D2C roundups for this category.

Avoid bare category words, and avoid queries whose first page will obviously be the excluded brands. If the category has Hindi or regional naming conventions worth a query, write one.

Treat the admin's starter queries as a floor, not a ceiling: keep what still works, sharpen what is vague, and add the surfaces they miss.

In your notes, say what you expect to be hard here — a category term that collides with something unrelated, a market with only a handful of independents, a surface you deliberately skipped and why.`;

export function buildSeedPrompt(
  input: StageIO["seed"]["input"],
  opts: PromptOptions
): StagePrompt {
  const { industry, icp } = input;

  const context = joinSections([
    section(
      "Industry",
      fieldLines({ Name: industry.name, Code: industry.code, Slug: industry.slug })
    ),
    section(
      "ICP config",
      fieldLines({
        "Revenue band": icp.revenue_band,
        "Follower band": icp.follower_band,
        "Ticket context": icp.ticket_context,
        "Admin notes": clamp(icp.notes, 800),
      })
    ),
    section(
      "Starter queries from the ICP config",
      numberedList(orderedUnique(icp.seed_queries ?? []))
    ),
    section(
      "Exclusion list — never a target, useful as query fuel",
      bulletList(sortedUnique(icp.exclusions ?? []))
    ),
  ]);

  return {
    system: buildSystemPrompt(opts),
    messages: [{ role: "user", content: `${BRIEF}\n\n${context}` }],
  };
}
