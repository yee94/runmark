import { describe, expect, it } from "bun:test";
import {
  isCodexAmbientSuggestionContent,
  isCodexAmbientSuggestionPrompt,
  isCodexAmbientSuggestionReply,
  transformUserPrompt,
} from "../src/transform";

describe("isCodexAmbientSuggestionPrompt", () => {
  it("detects Codex hyperpersonalized suggestion system prompt", () => {
    const prompt = `# Overview

Generate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex in this local project: /tmp/proj

Get an understanding of the user's intent and goals by deeply viewing their connected apps.`;
    expect(isCodexAmbientSuggestionPrompt(prompt)).toBe(true);
  });

  it("rejects normal user prompts", () => {
    expect(isCodexAmbientSuggestionPrompt("帮我修一下 README")).toBe(false);
    expect(isCodexAmbientSuggestionPrompt("suggestions for refactor")).toBe(false);
    expect(isCodexAmbientSuggestionPrompt("")).toBe(false);
    expect(isCodexAmbientSuggestionPrompt(null)).toBe(false);
  });
});

describe("isCodexAmbientSuggestionReply", () => {
  it("detects Codex ambient suggestions JSON reply", () => {
    const reply = JSON.stringify({
      suggestions: [
        {
          title: "Fix retry scope",
          description: "Preserve original session scope on retry.",
          prompt: "Patch buildRetryInput to keep append_matters.",
          appId: "local-project",
        },
      ],
    });
    expect(isCodexAmbientSuggestionReply(reply)).toBe(true);
    expect(isCodexAmbientSuggestionContent(reply)).toBe(true);
  });

  it("rejects normal assistant JSON or incomplete suggestion blobs", () => {
    expect(isCodexAmbientSuggestionReply('{"ok":true}')).toBe(false);
    expect(isCodexAmbientSuggestionReply('{"suggestions":[]}')).toBe(false);
    expect(
      isCodexAmbientSuggestionReply(
        JSON.stringify({ suggestions: [{ title: "only title" }] }),
      ),
    ).toBe(false);
    expect(isCodexAmbientSuggestionReply("普通回复")).toBe(false);
  });
});

describe("transformUserPrompt", () => {
  it("maps normal prompt to message event", () => {
    const ev = transformUserPrompt({
      session_id: "s1",
      hook_event_name: "UserPromptSubmit",
      prompt: "fix the bug",
      model: "gpt-5.4",
      turn_id: "t1",
    });
    expect(ev).toMatchObject({
      type: "message",
      role: "user",
      content: "fix the bug",
      session_id: "s1",
    });
  });
});
