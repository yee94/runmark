import { describe, expect, it } from "bun:test";
import { forkSourceTitle, isForkReplayTurn, isForkSessionTitle } from "../src/fork";

describe("fork session helpers", () => {
  it("detects OpenCode fork title suffix", () => {
    expect(isForkSessionTitle("New session (fork #1)")).toBe(true);
    expect(isForkSessionTitle("合并本月用量 (fork #2)")).toBe(true);
    expect(isForkSessionTitle("New session - 2026-06-15T12:17:56.684Z (fork #1)")).toBe(true);
    expect(isForkSessionTitle("normal session")).toBe(false);
    expect(isForkSessionTitle("fork branch discussion")).toBe(false);
    expect(isForkSessionTitle(null)).toBe(false);
  });

  it("strips fork suffix for source title lookup", () => {
    expect(forkSourceTitle("New session - 2026-06-15T12:17:56.684Z (fork #1)")).toBe(
      "New session - 2026-06-15T12:17:56.684Z",
    );
    expect(forkSourceTitle("normal session")).toBe("normal session");
  });

  it("treats turns completed before fork cutoff as replay", () => {
    const forkAt = 1_781_602_775_019;
    expect(isForkReplayTurn(forkAt - 60_000, forkAt)).toBe(true);
    expect(isForkReplayTurn(forkAt, forkAt)).toBe(false);
    expect(isForkReplayTurn(forkAt + 1, forkAt)).toBe(false);
    expect(isForkReplayTurn(undefined, forkAt)).toBe(false);
    expect(isForkReplayTurn(forkAt - 1, undefined)).toBe(false);
  });
});
