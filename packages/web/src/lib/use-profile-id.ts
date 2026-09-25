import { useSyncExternalStore } from "react";
import { getStoredProfileId, subscribeProfile } from "./profile.ts";

// The active profile as React state: the default profile reads as "default" so a key built from it
// is never empty
export function useProfileId(): string {
  return useSyncExternalStore(subscribeProfile, () => getStoredProfileId() ?? "default", () => "default");
}
