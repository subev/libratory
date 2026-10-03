import { memo, type ReactNode } from "react";
import type { BilingualLane, BilingualPair, BilingualSide } from "../../../../server/src/lib/bilingual-format.ts";
import type { PairLayout } from "../../lib/bilingual-reading.ts";
import type { useWordMeaning } from "./WordMeaning.tsx";

type Props = {
  pair: BilingualPair;
  lane: BilingualLane;
  side: BilingualSide;
  layout: PairLayout | undefined;
  active: boolean;
  current: boolean;
  speakingToken: number | null;
  linked: readonly number[];
  inspected: readonly number[];
  meaningToken: number | null;
  tabStop: number | null;
  handlers: ReturnType<typeof useWordMeaning>["handlers"];
  onActivate: (pair: BilingualPair, side: BilingualSide, token: number, anchor: HTMLButtonElement) => void;
};

export const BilingualPassage = memo(function BilingualPassage({ pair, lane, side, layout, active, current, speakingToken, linked, inspected, meaningToken, tabStop, handlers, onActivate }: Props) {
  if (!layout) return null;
  const pieces: ReactNode[] = [];
  for (const { token, before, text } of layout.tokens) {
    const speaking = speakingToken === token.id;
    const selected = inspected.includes(token.id) || meaningToken === token.id;
    pieces.push(before,
      <button
        key={token.id}
        type="button"
        tabIndex={tabStop === token.id ? 0 : -1}
        aria-describedby={meaningToken === token.id ? "word-meaning word-navigation" : "word-navigation"}
        aria-label={`Listen from ${lane.text.slice(...token.range)}`}
        className={`inline cursor-pointer select-text rounded-sm hover:bg-(--accent)/18 ${speaking ? "bg-(--accent)/35" : ""} ${linked.includes(token.id) ? "underline decoration-(--accent-text) decoration-2 underline-offset-4" : ""} ${selected ? "bg-(--accent)/18" : ""}`}
        data-testid={speaking ? "reader-word" : undefined}
        data-token={`${side}:${token.id}`}
        {...handlers({ pair: pair.id, side, token: token.id })}
        onClick={(event) => onActivate(pair, side, token.id, event.currentTarget)}
      >{text}</button>,
    );
  }
  pieces.push(layout.after);
  return <span className={active ? "rounded-sm bg-(--accent)/10" : undefined}
    title={pair.status === "uncertain" ? "Pairing uncertain" : undefined}
    data-testid={current ? "text-cue-active" : undefined}>{pieces}</span>;
});
