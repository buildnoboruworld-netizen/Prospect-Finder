import { z } from "zod";

// zod v4 APIs (z.email / z.url / z.uuid).

const emptyToUndef = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

export const digitalPresenceValues = [
  "WEB_ACTIVE",
  "WEB_THIN",
  "AMAZON_ONLY",
  "IG_ONLY",
  "NONE",
] as const;

export const confidenceValues = ["high", "med", "low"] as const;
export const contactRoleValues = ["founder", "marketing", "other"] as const;
export const channelStatusValues = [
  "verified",
  "public_generic",
  "unknown",
] as const;

export const companyInputSchema = z.object({
  industry_id: z.uuid("Pick an industry"),
  name: z.preprocess(
    emptyToUndef,
    z.string("Company name is required").trim().min(2, "Company name is required")
  ),
  domain: z.preprocess(
    emptyToUndef,
    z
      .string()
      .trim()
      .regex(/^\S+\.\S+$/, "Enter a domain like brand.com")
      .optional()
  ),
  instagram_handle: z.preprocess(emptyToUndef, z.string().trim().optional()),
  city: z.preprocess(emptyToUndef, z.string().trim().optional()),
  ig_followers_band: z.preprocess(emptyToUndef, z.string().trim().optional()),
  revenue_estimate: z.preprocess(emptyToUndef, z.string().trim().optional()),
  funding_stage: z.preprocess(emptyToUndef, z.string().trim().optional()),
  shark_tank_status: z.preprocess(emptyToUndef, z.string().trim().optional()),
  digital_presence: z.enum(digitalPresenceValues).optional(),
  fit_score: z.coerce.number().int().min(1).max(5).optional(),
  hook: z.preprocess(emptyToUndef, z.string().trim().max(500).optional()),
  confidence: z.enum(confidenceValues).optional(),
  sources: z.array(z.object({ url: z.url("Sources must be valid URLs"), note: z.string().optional() })).default([]),
});

export type CompanyInput = z.infer<typeof companyInputSchema>;

export const contactInputSchema = z
  .object({
    company_id: z.uuid(),
    full_name: z.preprocess(emptyToUndef, z.string().trim().optional()),
    designation: z.preprocess(emptyToUndef, z.string().trim().optional()),
    role_type: z.enum(contactRoleValues).default("other"),
    email: z.preprocess(emptyToUndef, z.email("Invalid email").optional()),
    email_status: z.enum(channelStatusValues).default("unknown"),
    phone: z.preprocess(emptyToUndef, z.string().trim().optional()),
    phone_status: z.enum(channelStatusValues).default("unknown"),
    is_primary: z.boolean().default(false),
  })
  .refine((c) => c.full_name || c.email || c.phone, {
    message: "A contact needs at least a name, email, or phone",
    path: ["full_name"],
  });

export type ContactInput = z.infer<typeof contactInputSchema>;

// Contacts a human types in are never 'verified' — that status is reserved
// for enrichment-API results (PRD §6.1 guardrail). Applied server-side.
export function clampManualChannelStatus(
  status: (typeof channelStatusValues)[number]
): "public_generic" | "unknown" {
  return status === "verified" ? "public_generic" : status;
}
