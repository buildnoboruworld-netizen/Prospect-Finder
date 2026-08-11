import "server-only";

// Fixture provider: replays a hand-written millets dataset with zero network
// calls, so the whole engine — validation, guardrails, dedup, cost meter,
// resumability — can be exercised without an API key.
//
// It deliberately returns REAL stage-shaped JSON rather than pre-approved
// leads: a fixture with a bad source or an invented email must get dropped by
// the same guardrails a live run uses. That is the point of it.
//
// Every brand below is fictional and every URL sits on a `.example` host, an
// IANA-reserved TLD that can never resolve.

import type { ConfidenceLevel, ContactRoleType, DigitalPresence } from "@/lib/types";
import type { ExclusionReason } from "../contracts";
import type {
  Citation,
  PriceBook,
  ProviderCall,
  ProviderCapabilities,
  ProviderResponse,
  ProviderUsage,
  ResearchProvider,
} from "../types";
import { ProviderError } from "../types";

const MODEL_ID = "demo-fixtures-millets-v1";

/** Enough delay that the live stage-progress UI is actually exercisable. */
const SIMULATED_LATENCY_MS = 450;

const SAMPLE_WARNING =
  "Sample data — no research was performed. These results are replayed fixtures " +
  "from the millets demo dataset, whatever industry was requested. Set " +
  "ANTHROPIC_API_KEY and RESEARCH_PROVIDER=anthropic to run real research.";

const CAPABILITIES: ProviderCapabilities = {
  search: "none",
  structuredOutputWithSearch: true,
  structuredOutput: "schema_enforced",
  sourceFidelity: "low",
  safeForContactData: true,
  promptCaching: false,
  suggestedQualifyBatchSize: 8,
  maxOutputTokens: 16_000,
};

const PRICE_BOOK: PriceBook = {
  inputPerMTok: 0,
  outputPerMTok: 0,
  cacheReadPerMTok: 0,
  cacheWritePerMTok: 0,
  searchPerThousand: 0,
  note: "Sample data — no provider was called, so no cost was incurred.",
};

interface DemoBrand {
  name: string;
  domain: string;
  handle: string;
  city: string;
  why: string;
  founder: string;
  followersBand: string;
  revenueEstimate: string;
  fundingStage: string;
  sharkTankStatus: string;
  siteContentDepth: "rich" | "thin" | "none";
  amazonPresence: boolean;
  digitalPresence: DigitalPresence;
  fitScore: number;
  hook: string;
  confidence: ConfidenceLevel;
  contactName: string | null;
  designation: string | null;
  contactRole: ContactRoleType;
  email: string | null;
  phone: string | null;
}

const BRANDS: readonly DemoBrand[] = [
  {
    name: "Sample Millet Co",
    domain: "samplemilletco.example",
    handle: "@samplemilletco",
    city: "Bengaluru",
    why: "Single-category millet snacking brand, D2C-first, no visible agency retainer.",
    founder: "Asha Sample",
    followersBand: "10k–50k",
    revenueEstimate: "₹2–5 Cr",
    fundingStage: "Bootstrapped",
    sharkTankStatus: "Not featured",
    siteContentDepth: "rich",
    amazonPresence: true,
    digitalPresence: "WEB_ACTIVE",
    fitScore: 5,
    hook: "Strong recipe content but no organic search footprint — a blog+SEO retainer is the obvious first win.",
    confidence: "high",
    contactName: "Asha Sample",
    designation: "Founder",
    contactRole: "founder",
    email: "hello@samplemilletco.example",
    phone: null,
  },
  {
    name: "Ragi Roots Foods",
    domain: "ragiroots.example",
    handle: "@ragirootsfoods",
    city: "Mysuru",
    why: "Ragi-led breakfast range with steady launch cadence and an in-house marketer.",
    founder: "Vikram Sample",
    followersBand: "10k–50k",
    revenueEstimate: "₹1–3 Cr",
    fundingStage: "Angel",
    sharkTankStatus: "Not featured",
    siteContentDepth: "rich",
    amazonPresence: true,
    digitalPresence: "WEB_ACTIVE",
    fitScore: 4,
    hook: "Publishes often but nothing ranks; topical clustering would compound what they already write.",
    confidence: "high",
    contactName: null,
    designation: null,
    contactRole: "marketing",
    email: "care@ragiroots.example",
    phone: "+91 00000 00000",
  },
  {
    name: "Bajra & Barn",
    domain: "bajraandbarn.example",
    handle: "@bajraandbarn",
    city: "Jaipur",
    why: "Farmer-collective millet flours, growing on Instagram, site is barely a storefront.",
    founder: "Meera Sample",
    followersBand: "5k–10k",
    revenueEstimate: "₹50L–1 Cr",
    fundingStage: "Bootstrapped",
    sharkTankStatus: "Not featured",
    siteContentDepth: "thin",
    amazonPresence: false,
    digitalPresence: "WEB_THIN",
    fitScore: 4,
    hook: "All demand sits on Instagram; a content-led site would stop them renting their audience.",
    confidence: "med",
    contactName: "Meera Sample",
    designation: "Co-founder",
    contactRole: "founder",
    email: null,
    phone: null,
  },
  {
    name: "Little Millet Kitchen",
    domain: "littlemilletkitchen.example",
    handle: "@littlemilletkitchen",
    city: "Pune",
    why: "Ready-to-cook millet meal kits; marketplace-heavy, own site under-used.",
    founder: "Rohan Sample",
    followersBand: "5k–10k",
    revenueEstimate: "₹1–2 Cr",
    fundingStage: "Bootstrapped",
    sharkTankStatus: "Not featured",
    siteContentDepth: "thin",
    amazonPresence: true,
    digitalPresence: "WEB_THIN",
    fitScore: 3,
    hook: "Marketplace margin is capping them; owned organic traffic is the cheapest way off it.",
    confidence: "med",
    contactName: null,
    designation: null,
    contactRole: "other",
    email: "orders@littlemilletkitchen.example",
    phone: null,
  },
  {
    name: "Foxtail Farms Collective",
    domain: "foxtailfarms.example",
    handle: "@foxtailfarmsco",
    city: "Coimbatore",
    why: "Foxtail-millet staples with a well-built site but almost no editorial output.",
    founder: "Priya Sample",
    followersBand: "1k–5k",
    revenueEstimate: "₹50L–1 Cr",
    fundingStage: "Bootstrapped",
    sharkTankStatus: "Not featured",
    siteContentDepth: "rich",
    amazonPresence: false,
    digitalPresence: "WEB_ACTIVE",
    fitScore: 3,
    hook: "Good site, empty blog — the infrastructure for organic growth is already paid for.",
    confidence: "low",
    contactName: "Priya Sample",
    designation: "Founder",
    contactRole: "founder",
    email: "priya@foxtailfarms.example",
    phone: null,
  },
];

const EXCLUSIONS: ReadonlyArray<{ name: string; reason: ExclusionReason }> = [
  { name: "Sample Millet Megacorp", reason: "too_big" },
  { name: "Sample Grain Traders", reason: "off_icp" },
];

export function createDemoProvider(): ResearchProvider {
  return {
    id: "demo",
    modelId: MODEL_ID,
    capabilities: CAPABILITIES,
    priceBook: PRICE_BOOK,
    isConfigured: () => true,
    missingConfig: () => [],
    generate,
  };
}

async function generate(call: ProviderCall): Promise<ProviderResponse> {
  await simulateLatency(call.signal);

  const brands = call.stage === "qualify" ? brandsInBatch(call) : BRANDS;

  return {
    raw: stageOutput(call.stage, brands),
    citations: citationsFor(brands),
    usage: simulatedUsage(),
    stopReason: "complete",
    modelId: MODEL_ID,
    warnings: [SAMPLE_WARNING],
  };
}

function stageOutput(stage: ProviderCall["stage"], brands: readonly DemoBrand[]): unknown {
  switch (stage) {
    case "seed":
      return {
        queries: [
          "millet snack brand India direct to consumer",
          "ragi flour D2C brand founder interview",
          "small millet startup Bengaluru Instagram",
          "foxtail millet brand India online store",
        ],
        notes: "Sample seed plan — fixture data, not a real search plan.",
      };

    case "discover":
      return {
        candidates: brands.map(toCandidate),
        excluded: EXCLUSIONS.map((e) => ({ ...e })),
      };

    case "qualify":
      return { profiles: brands.map(toProfile) };

    case "score":
      return {
        leads: brands.map(toLead),
        shortfallExplanation:
          `Sample dataset holds only ${BRANDS.length} millet brands, below the run target. ` +
          "No additional research was performed and nothing was padded to close the gap.",
      };
  }
}

function toCandidate(brand: DemoBrand) {
  return {
    name: brand.name,
    domain: brand.domain,
    instagramHandle: brand.handle,
    city: brand.city,
    why: brand.why,
    sources: sourcesFor(brand),
  };
}

function toProfile(brand: DemoBrand) {
  return {
    ...toCandidate(brand),
    founderName: brand.founder,
    igFollowersBand: brand.followersBand,
    revenueEstimate: brand.revenueEstimate,
    fundingStage: brand.fundingStage,
    sharkTankStatus: brand.sharkTankStatus,
    hasOwnSite: true,
    siteContentDepth: brand.siteContentDepth,
    amazonPresence: brand.amazonPresence,
    publicContacts: contactsFor(brand),
  };
}

function toLead(brand: DemoBrand) {
  return {
    name: brand.name,
    domain: brand.domain,
    instagram_handle: brand.handle,
    ig_followers_band: brand.followersBand,
    city: brand.city,
    revenue_estimate: brand.revenueEstimate,
    funding_stage: brand.fundingStage,
    shark_tank_status: brand.sharkTankStatus,
    digital_presence: brand.digitalPresence,
    fit_score: brand.fitScore,
    hook: brand.hook,
    confidence: brand.confidence,
    sources: sourcesFor(brand),
    public_contacts: contactsFor(brand),
  };
}

function sourcesFor(brand: DemoBrand) {
  return [
    { url: `https://${brand.domain}/`, note: "Brand home page" },
    { url: `https://${brand.domain}/about`, note: "Founder and origin story" },
  ];
}

function contactsFor(brand: DemoBrand) {
  if (!brand.email && !brand.phone && !brand.contactName) return [];
  return [
    {
      fullName: brand.contactName,
      designation: brand.designation,
      roleType: brand.contactRole,
      email: brand.email,
      phone: brand.phone,
      sourceUrl: `https://${brand.domain}/contact`,
    },
  ];
}

// The engine's source-authenticity guardrail keeps only URLs it saw retrieved,
// so the fixture publishes its own retrieval set. sourceFidelity 'low' is how
// the UI tells a reader these were asserted, not verified.
function citationsFor(brands: readonly DemoBrand[]): Citation[] {
  const retrievedAt = new Date().toISOString();
  return brands.flatMap((brand) => [
    ...sourcesFor(brand).map((source) => ({
      url: source.url,
      title: `${brand.name} — ${source.note}`,
      quotedText: null,
      retrievedAt,
      via: "provider_native" as const,
    })),
    {
      url: `https://${brand.domain}/contact`,
      title: `${brand.name} — contact page`,
      quotedText: null,
      retrievedAt,
      via: "provider_native" as const,
    },
  ]);
}

/** Qualify runs in batches; honour the batch so cursoring behaves like a live run. */
function brandsInBatch(call: ProviderCall): readonly DemoBrand[] {
  const haystack = call.messages.map((m) => m.content).join("\n").toLowerCase();
  const matched = BRANDS.filter((brand) => haystack.includes(brand.name.toLowerCase()));
  return matched.length > 0 ? matched : BRANDS;
}

function simulatedUsage(): ProviderUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    searches: 0,
    searchesCountedBy: "estimated",
    providerReportedCostUsd: 0,
    simulated: true,
  };
}

function simulateLatency(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new ProviderError("timeout", "Stage deadline reached before the fixture returned"));
      return;
    }
    const pending: { timer?: ReturnType<typeof setTimeout> } = {};
    const onAbort = () => {
      clearTimeout(pending.timer);
      reject(new ProviderError("timeout", "Stage deadline reached before the fixture returned"));
    };
    pending.timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, SIMULATED_LATENCY_MS);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
