import { z } from "zod";
import { DEFAULT_PROFILE_ID } from "../schema.ts";

// The seeded default ID predates Zod 4's RFC UUID validation; keep it addressable.
export const profileIdSchema = z.union([z.uuid(), z.literal(DEFAULT_PROFILE_ID)]);
