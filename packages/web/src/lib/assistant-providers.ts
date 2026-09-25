// The three steps to a key, per cloud provider, for the panel's setup tiles. Keyed by the env var
// the server's secrets table uses, so a tile and the key it writes cannot drift apart. The URLs,
// key prefixes and cost lines are checked by hand against each provider's own pages — verify them
// again before a release; nothing here can be tested.
import type { RouterInputs } from "../../../server/src/router.ts";

export type ProviderSetup = {
  envVar: RouterInputs["secrets"]["connect"]["envVar"];
  label: string;
  recommended?: boolean;
  // Where a key is made, and what the page calls the button
  keysUrl: string;
  createLabel: string;
  // What a pasted key starts with — a paste that does not is refused before any request is made
  keyPrefix: string;
  cost: string;
};

export const PROVIDER_SETUP: ProviderSetup[] = [
  {
    envVar: "DEEPSEEK_API_KEY",
    label: "DeepSeek",
    recommended: true,
    keysUrl: "https://platform.deepseek.com/api_keys",
    createLabel: "Create new API key",
    keyPrefix: "sk-",
    cost: "Prepaid, pay per use. A few cents covers a whole book's worth of questions.",
  },
  {
    envVar: "OPENAI_API_KEY",
    label: "OpenAI",
    keysUrl: "https://platform.openai.com/api-keys",
    createLabel: "Create new secret key",
    keyPrefix: "sk-",
    cost: "Pay per use, billed to the account. Cents per book with the smaller models.",
  },
  {
    envVar: "ANTHROPIC_API_KEY",
    label: "Anthropic",
    keysUrl: "https://console.anthropic.com/settings/keys",
    createLabel: "Create Key",
    keyPrefix: "sk-ant-",
    cost: "Prepaid, pay per use. Cents per book with the smaller models.",
  },
  {
    envVar: "GOOGLE_GENERATIVE_AI_API_KEY",
    label: "Google Gemini",
    keysUrl: "https://aistudio.google.com/app/apikey",
    createLabel: "Create API key",
    keyPrefix: "AIza",
    cost: "A free tier with daily limits, then pay per use.",
  },
];
