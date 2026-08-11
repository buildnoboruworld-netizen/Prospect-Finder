// zod contracts for the four stage outputs.
//
// These are authoritative regardless of what a provider claims to enforce:
// even schema-constrained providers get re-validated here, so a vendor that
// silently degrades its structured-output guarantee cannot corrupt a run.

import { z } from "zod";
import {
  confidenceValues,
  contactRoleValues,
  digitalPresenceValues,
} from "@/lib/schemas";

const nullableStr = z.string().trim().min(1).nullable().catch(null);

export const sourceSchema = z.object({
  url: z.url(),
  note: z.string().max(300).optional(),
});

// ── seed ────────────────────────────────────────────────────────────────────

export const seedPlanSchema = z.object({
  queries: z.array(z.string().trim().min(3)).min(1).max(30),
  notes: nullableStr,
});

// ── discover ────────────────────────────────────────────────────────────────

export const candidateSchema = z.object({
  name: z.string().trim().min(2).max(200),
  domain: nullableStr,
  instagramHandle: nullableStr,
  city: nullableStr,
  why: z.string().trim().max(400),
  sources: z.array(sourceSchema).default([]),
});

export const discoverOutputSchema = z.object({
  candidates: z.array(candidateSchema).max(80),
  excluded: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(200),
        reason: z.enum([
          "too_big",
          "duplicate",
          "rejected",
          "off_icp",
          "no_source",
        ]),
      })
    )
    .default([]),
});

// ── qualify ─────────────────────────────────────────────────────────────────

export const researchContactSchema = z.object({
  fullName: nullableStr,
  designation: nullableStr,
  roleType: z.enum(contactRoleValues).catch("other"),
  email: z.string().trim().toLowerCase().nullable().catch(null),
  phone: nullableStr,
  sourceUrl: z.url(),
});

export const qualifiedProfileSchema = candidateSchema.extend({
  founderName: nullableStr,
  igFollowersBand: nullableStr,
  revenueEstimate: nullableStr,
  fundingStage: nullableStr,
  sharkTankStatus: nullableStr,
  hasOwnSite: z.boolean().catch(false),
  siteContentDepth: z.enum(["rich", "thin", "none"]).catch("none"),
  amazonPresence: z.boolean().catch(false),
  publicContacts: z.array(researchContactSchema).default([]),
});

export const qualifyOutputSchema = z.object({
  profiles: z.array(qualifiedProfileSchema).max(60),
});

// ── score ───────────────────────────────────────────────────────────────────

export const scoredLeadSchema = z.object({
  name: z.string().trim().min(2).max(200),
  domain: nullableStr,
  instagram_handle: nullableStr,
  ig_followers_band: nullableStr,
  city: nullableStr,
  revenue_estimate: nullableStr,
  funding_stage: nullableStr,
  shark_tank_status: nullableStr,
  digital_presence: z.enum(digitalPresenceValues),
  fit_score: z.number().int().min(1).max(5),
  hook: z.string().trim().min(1).max(500),
  confidence: z.enum(confidenceValues),
  sources: z.array(sourceSchema),
  public_contacts: z.array(researchContactSchema).default([]),
});

export const scoreOutputSchema = z.object({
  leads: z.array(scoredLeadSchema).max(40),
  shortfallExplanation: nullableStr,
});

export type SeedPlanRaw = z.infer<typeof seedPlanSchema>;
export type DiscoverOutputRaw = z.infer<typeof discoverOutputSchema>;
export type QualifyOutputRaw = z.infer<typeof qualifyOutputSchema>;
export type ScoreOutputRaw = z.infer<typeof scoreOutputSchema>;
