export type Check = { label: string; s: string[]; t: string[] };
export type Row = { s: string; t: string; checks: Check[] };
export type Fixture = { key: string; from: string; to: string; sourceLocale: string; targetLocale: string; rows: Row[] };

// Targeted, agent-authored checks frozen before model calls; not a native-reviewed gold corpus.
// A suffix #2 addresses the second occurrence, rather than guessing from model output order.
export const fixtures: Fixture[] = [
  { key: "en-he", from: "English", to: "Hebrew", sourceLocale: "en", targetLocale: "he", rows: [
    { s: "The boy gave the girl a book.", t: "הילד נתן לילדה ספר.", checks: [{ label: "recipient prefix", s: ["girl"], t: ["לילדה"] }, { label: "book", s: ["book"], t: ["ספר"] }] },
    { s: "She turned the light off.", t: "היא כיבתה את האור.", checks: [{ label: "split verb", s: ["turned", "off"], t: ["כיבתה"] }, { label: "light", s: ["light"], t: ["האור"] }] },
    { s: "I saw her mother with her.", t: "ראיתי את אמא שלה איתה.", checks: [{ label: "possessive her", s: ["her"], t: ["שלה"] }, { label: "final her", s: ["her#2"], t: ["איתה"] }] },
    { s: "He did not open the door.", t: "הוא לא פתח את הדלת.", checks: [{ label: "negation", s: ["not"], t: ["לא"] }, { label: "open", s: ["open"], t: ["פתח"] }] },
    { s: "The bank is near the river bank.", t: "הבנק נמצא ליד גדת הנהר.", checks: [{ label: "financial bank", s: ["bank"], t: ["הבנק"] }, { label: "river bank", s: ["bank#2"], t: ["גדת"] }] },
    { s: "The small boy and the small girl laughed.", t: "הילד הקטן והילדה הקטנה צחקו.", checks: [{ label: "first small", s: ["small"], t: ["הקטן"] }, { label: "second small", s: ["small#2"], t: ["הקטנה"] }] },
    { s: "She gave him a book, and he gave her a pen.", t: "היא נתנה לו ספר, והוא נתן לה עט.", checks: [{ label: "first gave", s: ["gave"], t: ["נתנה"] }, { label: "second gave", s: ["gave#2"], t: ["נתן"] }] },
    { s: "He gave up.", t: "הוא ויתר.", checks: [{ label: "idiom", s: ["gave", "up"], t: ["ויתר"] }] },
    { s: "The train leaves at 08:30 from platform 2.", t: "הרכבת יוצאת בשעה 08:30 מרציף 2.", checks: [{ label: "mixed-direction number", s: ["2"], t: ["2"] }, { label: "platform prefix", s: ["platform"], t: ["מרציף"] }] },
    { s: "The children went home after school.", t: "הילדים הלכו הביתה אחרי בית הספר.", checks: [{ label: "home", s: ["home"], t: ["הביתה"] }, { label: "school expression", s: ["school"], t: ["בית", "הספר"] }] },
  ] },
  { key: "bg-de", from: "Bulgarian", to: "German", sourceLocale: "bg", targetLocale: "de", rows: [
    { s: "Момчето даде книга на момичето.", t: "Der Junge gab dem Mädchen ein Buch.", checks: [{ label: "recipient", s: ["момичето"], t: ["Mädchen"] }, { label: "book", s: ["книга"], t: ["Buch"] }] },
    { s: "Тя изключи лампата.", t: "Sie schaltete die Lampe aus.", checks: [{ label: "separable verb", s: ["изключи"], t: ["schaltete", "aus"] }, { label: "lamp", s: ["лампата"], t: ["Lampe"] }] },
    { s: "Видях майка ѝ с нея.", t: "Ich sah ihre Mutter mit ihr.", checks: [{ label: "possessive", s: ["ѝ"], t: ["ihre"] }, { label: "object pronoun", s: ["нея"], t: ["ihr"] }] },
    { s: "Той не отвори вратата.", t: "Er öffnete die Tür nicht.", checks: [{ label: "reordered negation", s: ["не"], t: ["nicht"] }, { label: "open", s: ["отвори"], t: ["öffnete"] }] },
    { s: "Банката е близо до брега на реката.", t: "Die Bank ist in der Nähe des Flussufers.", checks: [{ label: "financial bank", s: ["Банката"], t: ["Bank"] }, { label: "compound", s: ["брега", "реката"], t: ["Flussufers"] }] },
    { s: "Малкото момче и малкото момиче се засмяха.", t: "Der kleine Junge und das kleine Mädchen lachten.", checks: [{ label: "first small", s: ["Малкото"], t: ["kleine"] }, { label: "second small", s: ["малкото"], t: ["kleine#2"] }] },
    { s: "Тя му даде книга, а той ѝ даде химикалка.", t: "Sie gab ihm ein Buch, und er gab ihr einen Stift.", checks: [{ label: "first gave", s: ["даде"], t: ["gab"] }, { label: "second gave", s: ["даде#2"], t: ["gab#2"] }] },
    { s: "Той се отказа.", t: "Er gab auf.", checks: [{ label: "idiom", s: ["отказа"], t: ["gab", "auf"] }] },
    { s: "Влакът тръгва в 08:30 от перон 2.", t: "Der Zug fährt um 08:30 Uhr von Gleis 2 ab.", checks: [{ label: "number", s: ["2"], t: ["2"] }, { label: "departure verb", s: ["тръгва"], t: ["fährt", "ab"] }] },
    { s: "Децата се прибраха вкъщи след училище.", t: "Die Kinder gingen nach der Schule nach Hause.", checks: [{ label: "home expression", s: ["вкъщи"], t: ["nach#2", "Hause"] }, { label: "school", s: ["училище"], t: ["Schule"] }] },
  ] },
];
