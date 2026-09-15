import { describe, expect, it } from "vitest";

import type { FlatBlock, SourceBlock } from "./marker.ts";
import { matchBlockPolygons } from "./ocr-text-layer.ts";

const fresh = (page: number, text: string, polygon?: number[][]): FlatBlock => ({ type: "Text", text, hierarchy: null, page, included: true, ...(polygon ? { polygon } : {}) });
const source = (page: number, text: string, polygon?: number[][]): SourceBlock => ({ type: "Text", text, page, included: true, ...(polygon ? { polygon } : {}) });

describe("matchBlockPolygons", () => {
  it("gives each chapter block the polygon of the same block in the new layout, by page and text", () => {
    const { blocks, matched } = matchBlockPolygons(
      [source(3, "Беше нощ.", [[0, 0], [1, 0], [1, 1], [0, 1]]), source(3, "И валеше сняг, и духаше вятър, и никой не спеше в цялото село онази нощ."), source(4, "Сутринта.")],
      [fresh(3, "Беше нощ.", [[10, 10], [20, 10], [20, 20], [10, 20]]), fresh(3, "И валеше сняг, и духаше вятър, и никой не спеше в цялото село онази нощ, а после", [[5, 5], [6, 5], [6, 6], [5, 6]]), fresh(4, "Сутринта.")],
    );
    expect(matched).toBe(3);
    // An exact match on the same page; a changed ending falls through to the text's start
    expect(blocks[0]?.polygon).toEqual([[10, 10], [20, 10], [20, 20], [10, 20]]);
    expect(blocks[1]?.polygon).toEqual([[5, 5], [6, 5], [6, 6], [5, 6]]);
  });

  it("binds each new block once, so two blocks with the same text on a page get their own polygons", () => {
    const { blocks } = matchBlockPolygons(
      [source(1, "* * *"), source(1, "* * *")],
      [fresh(1, "* * *", [[1, 1], [2, 1], [2, 2], [1, 2]]), fresh(1, "* * *", [[5, 5], [6, 5], [6, 6], [5, 6]])],
    );
    expect(blocks.map((b) => b.polygon?.[0])).toEqual([[1, 1], [5, 5]]);
  });

  it("drops a stale polygon when the new layout could not place that block, and keeps a block it cannot find", () => {
    const { blocks, matched } = matchBlockPolygons(
      [source(1, "Placed once.", [[0, 0], [1, 0], [1, 1], [0, 1]]), source(1, "Never seen again.", [[2, 2], [3, 2], [3, 3], [2, 3]])],
      [fresh(1, "Placed once."), fresh(2, "Never seen again.", [[9, 9], [9, 9], [9, 9], [9, 9]])],
    );
    expect(matched).toBe(1);
    expect(blocks[0]).toEqual(source(1, "Placed once."));
    expect(blocks[1]?.polygon).toEqual([[2, 2], [3, 2], [3, 3], [2, 3]]);
  });
});
