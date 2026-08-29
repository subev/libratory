import { z } from "zod";

const uuid = z.string().uuid();

export function isUuid(value: string): boolean {
  return uuid.safeParse(value).success;
}
