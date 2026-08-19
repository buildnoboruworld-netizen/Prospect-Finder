// Stage 3 — depth, one batch of candidates at a time (the batch size comes from
// the provider's capabilities, because Vercel's 60s wall is ours to respect).
//
// The exclusion block and the brief are emitted before the batch so the prompt
// prefix stays identical across every batch of a run and the cache actually
// pays for itself.

import type { Candidate, StageIO } from "../contracts";
import {
  canonicalJson,
  exclusionBlock,
  icpBlock,
  joinSections,
  section,
} from "./render";
import { buildSystemPrompt, type PromptOptions, type StagePrompt } from "./system";

const BRIEF = `# Stage 3 of 4 — qualification

Deep-dive every brand in the batch below and build an evidence profile for each. Return exactly one profile per candidate, with the brand's name copied back character-for-character from the input so results can be matched to what was sent.

Budget roughly two to four page retrievals per brand and start with the brand's own website: one visit usually settles the site check, the city, often the founder, and — where permitted — the contact details. Spend what is left on one press, registry or marketplace check. Exhausting the budget on brand three and guessing at the rest is the failure mode here.

What to establish for each brand:

**Founder** — the person actually running the brand, from its own about page, press coverage, a Shark Tank appearance, or a company registry (MCA, Tofler, Zaubacorp). Not from LinkedIn. Nothing if you cannot see a name stated.

**City** — the operating or head-office city, from the site footer, contact page, policy pages or a registry filing. "India" alone is not a city; leave it empty.

**Instagram** — the real handle (correct the one you were given if it is wrong) and the follower count as a band, for example "8k–15k". Never invent a precise number and never estimate a band from a brand's vibe: if you could not see the profile, leave it empty.

**Revenue** — only from a figure someone actually stated: a funding report, a Shark Tank pitch, a founder interview, a registry filing. Record it with its basis, for example "₹2–3Cr FY24, stated in a founder interview". Never derive revenue from follower counts, review counts or product prices. Empty is the normal answer and it is a fine one.

**Funding** — bootstrapped, angel, pre-seed, seed, Series A and so on, with the round year when you have it. Say bootstrapped only when it is stated somewhere: unknown funding is unknown, not bootstrapped.

**Shark Tank** — season and outcome if the brand pitched ("S3, aired, no deal"; "S4, deal with Aman"). Say it did not appear only if you checked.

**Own site** — whether the brand runs a real storefront on its own domain. A link-in-bio page, an Instagram shop, a marketplace seller page, a parked domain or a 404 is not an own site.

**Site content depth** — judge what a search engine would find indexable, not how the site looks. Rich: maintained editorial that could actually rank — guides, recipes, comparisons, category or collection pages with real copy, touched within the last year or so. Thin: product and policy pages only, or a blog with a handful of posts and nothing recent. None: no site, or a single landing page. A beautiful theme with nothing to index is thin, and that is the most valuable finding in this whole profile — get it right rather than generous.

**Marketplace** — whether the brand itself sells on Amazon.in, through a brand store or its own seller account, plus Flipkart, Nykaa, Myntra or Blinkit if you see them. Third-party resellers listing the product are not the brand's presence; say which of the two you saw.

**Sources** — every URL you actually opened for that brand. At least one, ideally the brand's own site plus one independent page. A profile with no sources cannot become a lead, so returning it honestly empty is better than attaching a URL you did not read.

If a brand turns out to be disqualified on inspection — acquired, shut down, national in scale, not actually D2C, or the same company as an excluded brand under another name — still return its profile and begin your one-line summary with "Disqualified:" and the reason. Never silently drop a candidate: the number of profiles is checked against the batch, and a missing one reads as a system failure rather than a finding.

If you could retrieve nothing at all for a brand, return it with empty fields, no sources, and say so in the summary. The engine drops it; that is the correct outcome.`;

const CONTACT_TASK = `**Contact details** — from the brand's own domain only: contact, about, footer, shipping, returns or terms pages. In Indian D2C stores the legally required shipping/returns and terms pages are the highest-yield place to look, more reliably than the contact page itself. Copy what is printed, exactly, with the URL of the page you read it on, and mark whether it belongs to a founder, to someone in marketing, or is a generic inbox with no person attached. Never construct an address from the domain, never take one from a directory or lead-list site, and never treat an Instagram bio or a marketplace listing as the brand's own page. Finding nothing is a normal, correct outcome.`;

/** The prompt gate is belt-and-braces; the engine also strips contacts. */
const CONTACT_TASK_BLOCKED = `**Contact details** — not in scope for this run. Record no email addresses and no phone numbers, even where a page shows them plainly. The founder's name is still in scope as a matter of public record.`;

export function buildQualifyPrompt(
  input: StageIO["qualify"]["input"],
  opts: PromptOptions
): StagePrompt {
  const { batch, plan } = input;

  const context = joinSections([
    icpBlock(plan),
    section("Exclusions — a candidate matching any of these is disqualified", exclusionBlock(plan)),
    section(
      `Batch — ${batch.length} candidate${batch.length === 1 ? "" : "s"} from the discovery stage`,
      canonicalJson(batch.map(renderCandidate))
    ),
  ]);

  return {
    system: buildSystemPrompt(opts),
    messages: [
      {
        role: "user",
        content: `${BRIEF}\n\n${
          opts.allowContactData ? CONTACT_TASK : CONTACT_TASK_BLOCKED
        }\n\n${context}`,
      },
    ],
  };
}

function renderCandidate(candidate: Candidate) {
  return {
    name: candidate.name,
    domain: candidate.domain,
    instagramHandle: candidate.instagramHandle,
    city: candidate.city,
    whyDiscovered: candidate.why,
    knownSources: candidate.sources.map((s) => s.url),
  };
}
