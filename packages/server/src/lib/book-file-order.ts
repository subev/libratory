import { sql } from "drizzle-orm";
import { bookFiles } from "../schema.ts";

// The index owns cached extraction and chapter references; position only changes reading order.
export const bookFileOrder = sql<number>`coalesce(${bookFiles.position}, ${bookFiles.index})`;
