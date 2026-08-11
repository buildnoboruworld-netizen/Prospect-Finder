// Stage 3 — depth, one cursored batch at a time.
//
// This is the stage that decides what evidence a lead is allowed to carry, so
// it is also where a returned profile is reconciled against the candidate that
// was actually asked for. A profile for a brand nobody requested, or one whose
// sources this run never opened, is not evidence — it is the model filling in.

import { normalizeName } from "@/lib/normalize";
import { urlKey } from "../citations";
import type { Candidate, QualifiedProfile, ResearchContact, StageIO } from "../contracts";
import { buildQualifyPrompt } from "../prompts/qualify";
import type { PromptOptions } from "../prompts/system";
import { qualifyOutputSchema, type QualifyOutputRaw } from "../schemas";
import type { ProviderCall } from "../types";
import { keepRetrievedSources } from "./discover";

type StageContext = Omit<
  ProviderCall,
  "stage" | "system" | "messages" | "outputSchema" | "outputSchemaName"
>;

export interface QualifyResult {
  profiles: QualifiedProfile[];
  /** Candidates that came back unusable, in words a salesperson can read. */
  failures: Array<{ name: string; reason: string }>;
}

// The prompt asks the model to mark a candidate that falls apart on inspection
// rather than dropping it silently; enforcing the convention here is what keeps
// those brands out of the lead list and inside the shortfall count.
const DISQUALIFIED = /^\s*disqualified\s*:/i;

export function buildQualifyCall(
  input: StageIO["qualify"]["input"],
  ctx: StageContext,
  opts: PromptOptions
): ProviderCall {
  const prompt = buildQualifyPrompt(input, opts);
  return {
    ...ctx,
    stage: "qualify",
    system: prompt.system ?? "",
    messages: prompt.messages,
    outputSchema: qualifyOutputSchema,
    outputSchemaName: "QualifyOutput",
  };
}

export function toQualifiedProfiles(
  raw: QualifyOutputRaw,
  batch: Candidate[],
  retrievedUrls: Set<string>,
  allowContactData: boolean
): QualifyResult {
  const byName = new Map<string, Candidate>();
  for (const candidate of batch) {
    const key = normalizeName(candidate.name);
    if (key !== null) byName.set(key, candidate);
  }

  const profiles: QualifiedProfile[] = [];
  const failures: QualifyResult["failures"] = [];
  const matched = new Set<string>();

  for (const profile of raw.profiles) {
    const key = normalizeName(profile.name);
    const candidate = key === null ? undefined : byName.get(key);
    if (key === null || candidate === undefined) {
      failures.push({
        name: profile.name,
        reason: "Came back from qualification but was never one of the candidates sent, so it has no verified discovery behind it.",
      });
      continue;
    }
    if (matched.has(key)) {
      failures.push({ name: profile.name, reason: "Returned twice in one batch; the second copy was ignored." });
      continue;
    }
    matched.add(key);

    // A source that survived discovery is already proven retrieved; this
    // stage's own citations authorise everything else, including the page a
    // contact was read off.
    const authorised = new Set(retrievedUrls);
    for (const source of candidate.sources) {
      const authorisedKey = urlKey(source.url);
      if (authorisedKey !== null) authorised.add(authorisedKey);
    }

    const sources = keepRetrievedSources(
      [...candidate.sources, ...profile.sources],
      authorised
    );
    if (sources.length === 0) {
      failures.push({
        name: profile.name,
        reason: "Nothing we could actually open backs it up, so there is no evidence to score.",
      });
      continue;
    }

    if (DISQUALIFIED.test(profile.why)) {
      failures.push({ name: profile.name, reason: profile.why.trim() });
      continue;
    }

    profiles.push({
      name: profile.name,
      // Qualification is allowed to correct what discovery guessed at, but
      // never to blank it: an empty field here means "still unknown".
      domain: profile.domain ?? candidate.domain,
      instagramHandle: profile.instagramHandle ?? candidate.instagramHandle,
      city: profile.city ?? candidate.city,
      why: profile.why,
      sources,
      founderName: profile.founderName,
      igFollowersBand: profile.igFollowersBand,
      revenueEstimate: profile.revenueEstimate,
      fundingStage: profile.fundingStage,
      sharkTankStatus: profile.sharkTankStatus,
      hasOwnSite: profile.hasOwnSite,
      siteContentDepth: profile.siteContentDepth,
      amazonPresence: profile.amazonPresence,
      // A provider whose terms allow human review of submitted data does not
      // get to hand contact details back either — the prompt gate is advisory,
      // this one is not.
      publicContacts: allowContactData
        ? keepRetrievedContacts(profile.publicContacts, authorised)
        : [],
    });
  }

  for (const candidate of batch) {
    const key = normalizeName(candidate.name);
    if (key !== null && !matched.has(key)) {
      failures.push({ name: candidate.name, reason: "No profile came back for it in this batch." });
    }
  }

  return { profiles, failures };
}

function keepRetrievedContacts(
  contacts: ResearchContact[],
  authorised: Set<string>
): ResearchContact[] {
  return contacts.filter((contact) => {
    const key = urlKey(contact.sourceUrl);
    return key !== null && authorised.has(key);
  });
}
