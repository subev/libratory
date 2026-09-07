import { describe, expect, it } from "vitest";
import { detectLanguage } from "./detect-language.ts";

const english = "The telemarketers who have a procedures pattern sell three times as much as the options people. The reason for this is simple: sales is basically a procedure, and people who like following one follow it well. ".repeat(3);
const bulgarian = "Враждата между човека и Сатана е пророчество, включващо всички народи и всички времена. Божествената присъда, произнесена срещу Сатана след грехопадението на човека, представлява също и обещание. ".repeat(3);

describe("detectLanguage", () => {
  it("names the language of a page of prose", () => {
    expect(detectLanguage(english)).toBe("en");
    expect(detectLanguage(bulgarian)).toBe("bg");
  });

  it("says nothing on too little text", () => {
    expect(detectLanguage("Chapter 1")).toBeNull();
  });
});
