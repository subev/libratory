// In a compiled build process.execPath is the server binary itself, which re-runs the server
// unless BUN_BE_BUN makes it behave as the bun CLI; node ignores the variable. Every place that
// shells out to JS from the packaged app spawns process.execPath with this environment.
export const bunEnv = { ...process.env, BUN_BE_BUN: "1" };
