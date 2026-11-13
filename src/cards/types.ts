import { z } from "zod";

/**
 * A task card: one small change, written by the user, with the files it may touch and the
 * criteria that decide whether it is done. The format is td's (`docs/agents/night-shift.md`):
 * header lines `id:`, `title:`, `depends:`, `files:`, then a body whose `Accept:` paragraph
 * holds the acceptance criteria.
 */
export const CardSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "card id may contain letters, digits, '.', '_' and '-'"),
  title: z.string().min(1),
  depends: z.array(z.string().min(1)),
  /** Write scope: glob patterns. `*` stays inside one directory, `**` crosses directories. */
  files: z.array(z.string().min(1)).min(1),
  /** What to do and why: the body without its `Accept:` and `Notes:` paragraphs. */
  goal: z.string().min(1),
  acceptance: z.array(z.string().min(1)).min(1),
  notes: z.string().optional(),
  /** Where the card was read from; informational. */
  source: z.string().optional(),
});
export type Card = z.infer<typeof CardSchema>;

/** What a run was started with: the cards, the brief every worker gets, and what `--only` left out. */
export const CardRegistrationSchema = z.object({
  cards: z.array(CardSchema).min(1),
  /** The project-level brief text (td's `night-brief.md`), frozen at run start; empty when none. */
  brief: z.string(),
  briefSource: z.string().nullable(),
  /** `depends:` entries dropped because `--only` excluded their card; assumed already integrated. */
  droppedDependencies: z.array(z.object({ card: z.string(), dependsOn: z.string() })),
});
export type CardRegistration = z.infer<typeof CardRegistrationSchema>;

export const CARDS_REGISTERED_EVENT = "cards.registered";
