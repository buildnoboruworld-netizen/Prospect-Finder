// Stage 4 — judgement, not research. Classify presence, score fit, and write
// the hook, which is the field a salesperson actually opens with and therefore
// the one worth the most prompt.

import type { QualifiedProfile, StageIO } from "../contracts";
import {
  canonicalJson,
  clamp,
  exclusionBlock,
  fieldLines,
  joinSections,
  section,
} from "./render";
import { buildSystemPrompt, type PromptOptions, type StagePrompt } from "./system";

const BRIEF = `# Stage 4 of 4 — classify and score

Judge the profiles below and turn the ones that deserve it into leads. This is a judgement stage: work from the evidence already gathered rather than starting new research. Carry each brand's facts and source URLs through unchanged — do not reword them, do not improve them, and do not attach a source that is not already on the profile.

A lead is a conversation a salesperson will open tomorrow. A brand not worth that conversation does not belong in the list, whatever that does to the count.

## Digital presence — exactly one class per brand
- WEB_ACTIVE — own site with maintained, indexable content. Standard pitch.
- WEB_THIN — own site exists, content is thin or stale. The foundation is built and the discovery is missing: the cleanest pitch we have.
- AMAZON_ONLY — sells through marketplaces only; no own storefront, or the domain is dead or parked. Strongest pitch: every rupee of demand is rented.
- IG_ONLY — Instagram is the shop (DM to order, link-in-bio checkout), with no real site.
- NONE — nothing findable anywhere. Usually too early to sell to.

Decide in that order of evidence, and when there is no working own site, marketplace presence outranks Instagram: a brand on both Amazon and Instagram without a site is AMAZON_ONLY, because the classification is about who owns the demand.

## Fit score — 1 to 5 against the ICP, never against the other brands in this batch
Do not grade on a curve and do not spread the scores to look discriminating.
- 5 — Textbook: independent Indian D2C brand inside the revenue and follower bands, visible product demand, a glaring discovery gap, a named founder.
- 4 — Strong: fits the band with a real gap, but one leg is soft — no founder name, revenue unconfirmed, or content thin rather than absent.
- 3 — Plausible: in the band, but the gap is mild or the size evidence is weak. Worth a call, not a priority.
- 2 — Weak: probably outside the band in one direction or the other, or too little evidence to judge. Too big disqualifies exactly as firmly as too small — a brand that already runs this capability in-house is not a prospect.
- 1 — Should not be here at all. Do not return these as leads; count them in the shortfall instead.

## Confidence — about the evidence, not your enthusiasm
High: several independent retrieved pages including the brand's own site, with the deciding facts stated rather than inferred. Medium: the site was seen but size or revenue is inferred, or everything rests on a single source. Low: one weak third-party page, contradictory data, or the facts that decide the fit are simply unknown.

## The hook — the single most important thing you produce
One sentence a salesperson says out loud to open the conversation, naming this brand's specific gap in the language of evidence.

It must carry at least one concrete detail lifted from that brand's own profile: a number, a named channel, a product term, a date, or the competitor who owns the search results instead. Present tense, plain observation, roughly 15 to 35 words. No marketing adjectives, no pitch language — describe the gap, do not sell the fix.

The test: if the sentence could be pasted onto any other brand in this industry without changing a word, it is not a hook. Rewrite it.

Good — "40k Instagram followers and 900-odd Amazon reviews, but the site has no blog and ranks for nothing except its own name; every 'best ragi cookies' search goes to a competitor."
Good — "Sells only on Amazon and the .com forwards to a link-in-bio page, so all of the demand is rented."
Good — "Well-built Shopify store with eleven blog posts, all from 2022 — the foundation is there and completely undiscovered."
Bad — "Growing D2C brand with a strong social presence that could benefit from SEO."
Bad — "Has a clear discovery gap and would benefit from better content."
The bad ones carry no number, no channel and nothing that is true of this brand and false of its neighbours.

Never put a fact in the hook that is not in the profile's evidence. A person repeats this sentence to the founder it describes, so an invented follower count or an imagined competitor is not a rounding error — it loses the account.

## What does not ship
A brand with no source URLs cannot be a lead: leave it out and count it. Any brand matching the exclusion list is out even at this stage. Profiles the previous stage marked as disqualified are out, and belong in the shortfall count rather than the list.

## Shortfall
If you deliver fewer leads than the target, explain it in plain words: how many profiles came in, how many you dropped and for what, and what would actually help next time — a surface nobody searched, a city cluster worth a pass, or the honest observation that this category has very few independents left once the exclusions are removed. If the ICP band itself looks too narrow for the industry, say so; the person who tunes it reads this. Never act on that yourself by including brands outside the band. Do not withhold good leads to look selective, and do not add weak ones to reach the number.`;

const CONTACT_CARRY = `Carry any contact the previous stage recorded through untouched: do not add one, do not complete a partial one, do not tidy one up, and never mark one as verified.`;

export function buildScorePrompt(
  input: StageIO["score"]["input"],
  opts: PromptOptions
): StagePrompt {
  const { profiles, plan } = input;

  const context = joinSections([
    section(
      "Run context",
      fieldLines({
        "Target leads": plan.targetLeads,
        "Profiles in hand": profiles.length,
        "Planner notes": clamp(plan.notes, 800),
      })
    ),
    section("Exclusions — still out, even this late", exclusionBlock(plan)),
    section(
      "Qualified profiles",
      canonicalJson(profiles.map((p) => renderProfile(p, opts.allowContactData)))
    ),
  ]);

  const brief = opts.allowContactData ? `${BRIEF}\n\n${CONTACT_CARRY}` : BRIEF;

  return {
    system: buildSystemPrompt(opts),
    messages: [{ role: "user", content: `${brief}\n\n${context}` }],
  };
}

function renderProfile(profile: QualifiedProfile, allowContactData: boolean) {
  return {
    name: profile.name,
    domain: profile.domain,
    instagramHandle: profile.instagramHandle,
    igFollowersBand: profile.igFollowersBand,
    city: profile.city,
    founderName: profile.founderName,
    revenueEstimate: profile.revenueEstimate,
    fundingStage: profile.fundingStage,
    sharkTankStatus: profile.sharkTankStatus,
    hasOwnSite: profile.hasOwnSite,
    siteContentDepth: profile.siteContentDepth,
    amazonPresence: profile.amazonPresence,
    summary: profile.why,
    sources: profile.sources,
    // A provider that may not hold contact data must not be shown any, even as
    // pass-through context.
    publicContacts: allowContactData ? profile.publicContacts : [],
  };
}
