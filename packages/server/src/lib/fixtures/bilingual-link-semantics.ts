type MeaningGroup = { source: string; target: string; sourceOccurrence?: number; targetOccurrence?: number };
type SemanticFixture = { name: string; source: string; target: string; groups: MeaningGroup[] };

// Curated acceptable groups, not exhaustive labels or measured provider accuracy.
export const bilingualLinkSemantics: SemanticFixture[] = [
  {
    name: "river, contractions and three occurrences of she",
    source: "When she finally reached the river, she realized how much she missed her old friend.",
    target: "Lorsqu'elle atteignit enfin la rivière, elle réalisa à quel point son vieil ami lui manquait.",
    groups: [
      { source: "When she", target: "Lorsqu'elle" },
      { source: "finally", target: "enfin" },
      { source: "reached", target: "atteignit" },
      { source: "the", target: "la" },
      { source: "river", target: "rivière" },
      { source: "she", sourceOccurrence: 1, target: "elle" },
      { source: "realized", target: "réalisa" },
      { source: "how much", target: "à quel point" },
      { source: "she", sourceOccurrence: 2, target: "lui" },
      { source: "missed", target: "manquait" },
      { source: "her old friend", target: "son vieil ami" },
    ],
  },
  {
    name: "subject and object inversion", source: "I miss you.", target: "Tu me manques.",
    groups: [{ source: "I", target: "me" }, { source: "miss", target: "manques" }, { source: "you", target: "Tu" }],
  },
  {
    name: "different sense of missed", source: "He missed the train.", target: "Il a raté le train.",
    groups: [{ source: "He", target: "Il" }, { source: "missed", target: "a raté" }, { source: "the", target: "le" }, { source: "train", target: "train" }],
  },
  {
    name: "shared contraction tokens and repeated it",
    source: "He put it on the table because it was wet.", target: "Il l’a posé sur la table parce qu’il était mouillé.",
    groups: [
      { source: "He", target: "Il" }, { source: "put", target: "l’a posé" }, { source: "it", target: "l’a" },
      { source: "on", target: "sur" }, { source: "the", target: "la" }, { source: "table", target: "table" },
      { source: "because", target: "parce qu’il" }, { source: "it", sourceOccurrence: 1, target: "qu’il" },
      { source: "was", target: "était" }, { source: "wet", target: "mouillé" },
    ],
  },
  {
    name: "negated phrasal verb", source: "She didn't give up, even when it rained.", target: "Elle n’a pas abandonné, même quand il pleuvait.",
    groups: [{ source: "She", target: "Elle" }, { source: "didn't give up", target: "n’a pas abandonné" }, { source: "even", target: "même" }, { source: "when", target: "quand" }, { source: "it", target: "il" }, { source: "rained", target: "pleuvait" }],
  },
  {
    name: "complete idiom", source: "He gave her a hand with the heavy suitcase.", target: "Il lui a donné un coup de main avec la lourde valise.",
    groups: [{ source: "He", target: "Il" }, { source: "gave her a hand", target: "lui a donné un coup de main" }, { source: "with", target: "avec" }, { source: "the", target: "la" }, { source: "heavy", target: "lourde" }, { source: "suitcase", target: "valise" }],
  },
  {
    name: "number and reordered noun phrase", source: "In 1878, my younger sister bought three red books.", target: "En 1878, ma petite sœur a acheté trois livres rouges.",
    groups: [{ source: "In", target: "En" }, { source: "1878", target: "1878" }, { source: "my", target: "ma" }, { source: "younger sister", target: "petite sœur" }, { source: "bought", target: "a acheté" }, { source: "three", target: "trois" }, { source: "red books", target: "livres rouges" }],
  },
  {
    name: "identical phrases at distinct occurrences", source: "She saw her friend, and she called her friend.", target: "Elle vit son ami, et elle appela son ami.",
    groups: [{ source: "her friend", target: "son ami" }, { source: "her friend", sourceOccurrence: 1, target: "son ami", targetOccurrence: 1 }],
  },
];
