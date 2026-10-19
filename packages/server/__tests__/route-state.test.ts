import { describe, expect, it } from "bun:test";
import { TRACE_CATEGORIES } from "../public/modules/trace.eficy.js";
import {
  TRACE_ROUTE_CATEGORIES,
  canonicalizeTraceTypes,
  parseTraceRouteHash,
  parseTraceRouteQuery,
  serializeTraceRouteHash,
  serializeTraceRouteQuery,
  toggleTraceTypeSelection,
} from "../public/modules/route-state.js";

describe("trace route state", () => {
  it("keeps the same fixed category order as the trace helpers", () => {
    expect(TRACE_ROUTE_CATEGORIES).toEqual([
      "user",
      "reasoning",
      "assistant",
      "turn",
      "tool",
      "abort",
      "error",
      "subagent",
    ]);
    expect(TRACE_ROUTE_CATEGORIES).toEqual(TRACE_CATEGORIES);
  });

  it("canonicalizes types by dropping unknowns, deduping, and restoring fixed order", () => {
    expect(canonicalizeTraceTypes(["error", "user", "nope", "user", " tool "])).toEqual([
      "user",
      "tool",
      "error",
    ]);
    expect(canonicalizeTraceTypes(TRACE_ROUTE_CATEGORIES.slice())).toEqual([]);
    expect(canonicalizeTraceTypes(["", null, undefined])).toEqual([]);
  });

  it("uses one trace category and clears it when selected again", () => {
    expect(toggleTraceTypeSelection([], "assistant")).toEqual(["assistant"]);
    expect(toggleTraceTypeSelection(["user", "tool"], "error")).toEqual(["error"]);
    expect(toggleTraceTypeSelection(["assistant"], "assistant")).toEqual([]);
    expect(toggleTraceTypeSelection(["assistant"], "unknown")).toEqual([]);
  });

  it("parses sessions and share hashes for types, node, and child", () => {
    expect(parseTraceRouteHash("#/sessions/sess-1?types=error,user&node=turn-9&child=child-2")).toEqual({
      kind: "sessions",
      sessionId: "sess-1",
      shareToken: null,
      types: ["user", "error"],
      node: "turn-9",
      child: "child-2",
    });
    expect(parseTraceRouteHash("#/share/tok.sig?node=cursor-turn-a1&types=foo,tool")).toEqual({
      kind: "share",
      sessionId: null,
      shareToken: "tok.sig",
      types: ["tool"],
      node: "cursor-turn-a1",
      child: null,
    });
    expect(parseTraceRouteHash("#/sessions/" + encodeURIComponent("a/b"))).toEqual({
      kind: "sessions",
      sessionId: "a/b",
      shareToken: null,
      types: [],
      node: null,
      child: null,
    });
    expect(parseTraceRouteQuery("types=subagent,assistant&node=&child=child-9")).toEqual({
      types: ["assistant", "subagent"],
      node: null,
      child: "child-9",
    });
  });

  it("serializes with canonical order and omits defaults", () => {
    expect(serializeTraceRouteHash({
      kind: "sessions",
      sessionId: "sess-1",
      types: [],
      node: null,
      child: null,
    })).toBe("#/sessions/sess-1");
    expect(serializeTraceRouteHash({
      kind: "sessions",
      sessionId: "sess-1",
      types: TRACE_ROUTE_CATEGORIES.slice(),
      node: "",
      child: "",
    })).toBe("#/sessions/sess-1");
    expect(serializeTraceRouteHash({
      kind: "sessions",
      sessionId: "sess-1",
      types: ["error", "user"],
      node: "turn-9",
      child: "child-2",
    })).toBe("#/sessions/sess-1?types=user,error&node=turn-9&child=child-2");
    expect(serializeTraceRouteHash({
      kind: "share",
      shareToken: "tok.sig",
      types: ["tool"],
      node: "cursor-turn-a1",
    })).toBe("#/share/tok.sig?types=tool&node=cursor-turn-a1");
    expect(serializeTraceRouteHash({
      kind: "sessions",
      sessionId: "a/b",
    })).toBe("#/sessions/a%2Fb");
    expect(serializeTraceRouteQuery({
      types: ["nope", "abort"],
      node: "msg-1",
      child: null,
    })).toBe("types=abort&node=msg-1");
  });

  it("round-trips sessions and share hashes", () => {
    const sessionHash = "#/sessions/sess-1?types=user,error&node=turn-9&child=child-2";
    expect(serializeTraceRouteHash(parseTraceRouteHash(sessionHash))).toBe(sessionHash);
    expect(serializeTraceRouteHash(parseTraceRouteHash("#/share/tok.sig?child=child-9"))).toBe(
      "#/share/tok.sig?child=child-9",
    );
    expect(serializeTraceRouteHash(parseTraceRouteHash("#/sessions/sess-1?types=error,user,foo"))).toBe(
      "#/sessions/sess-1?types=user,error",
    );
  });

  it("keeps SPA parsing safe when percent escapes are malformed", () => {
    expect(() => parseTraceRouteHash("#/sessions/%E0%A4%A")).not.toThrow();
    expect(parseTraceRouteHash("#/sessions/%E0%A4%A")).toEqual({
      kind: "sessions",
      sessionId: "%E0%A4%A",
      shareToken: null,
      types: [],
      node: null,
      child: null,
    });
    expect(() => parseTraceRouteHash("#/share/%")).not.toThrow();
    expect(parseTraceRouteHash("#/share/%")).toEqual({
      kind: "share",
      sessionId: null,
      shareToken: "%",
      types: [],
      node: null,
      child: null,
    });
    expect(() => parseTraceRouteHash("#/sessions/sess%2?node=%GG&child=%E0%A4%A")).not.toThrow();
    const malformedQuery = parseTraceRouteHash("#/sessions/sess%2?node=%GG&child=%E0%A4%A");
    expect(malformedQuery.kind).toBe("sessions");
    expect(malformedQuery.sessionId).toBe("sess%2");
    expect(malformedQuery.node).toBe("%GG");
    expect(malformedQuery.child).not.toBeNull();
    expect(parseTraceRouteHash("#/sessions/" + encodeURIComponent("a/b")).sessionId).toBe("a/b");
  });
});
