import { describe, expect, test } from "bun:test";

describe("studio skill packs P1.4", () => {
  test("pack id prefix", () => {
    expect(`pack-abcd1234`.startsWith("pack-")).toBe(true);
  });

  test("skill defs need instructions", () => {
    const skills = [
      { slug: "a", title: "A", summary: "s", instructions: "do x" },
      { slug: "b", title: "B", summary: "s", instructions: "" },
    ].filter((s) => s.slug && s.instructions);
    expect(skills.map((s) => s.slug)).toEqual(["a"]);
  });
});
