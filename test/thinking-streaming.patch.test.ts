import { expect, test } from "bun:test";

const { patchContents } = require("../patch-claude-display.ts") as {
  patchContents(
    contents: string[],
    options: { disable: string[] }
  ): {
    contents: string[];
    patchResults: Map<string, { candidates: number; patched: number }>;
  };
};

const disabledPatches = [
  "tool-call-verbose",
  "create-diff-colors",
  "word-diff-line-bg",
  "thinking-inline",
  "redacted-thinking-inline",
  "subagent-prompt",
  "disable-spinner-tips",
  "version-output",
  "installer-label",
  "welcome-badge",
];

for (const [version, source, expected] of [
  [
    "2.1.257",
    'vT=Le(process.env.CLAUDE_CODE_DISABLE_THINKING),Lv=r.type!=="disabled"&&!vT,vy=Lv&&Tb()&&gEt(U),kE=vy?r.display:void 0,xy=void 0;',
    'vT=Le(process.env.CLAUDE_CODE_DISABLE_THINKING),Lv=r.type!=="disabled"&&!vT,vy=Lv&&Tb()&&gEt(U),kE=vy?r.display??"summarized":void 0,xy=void 0;',
  ],
  [
    "2.1.259",
    'mT=De(process.env.CLAUDE_CODE_DISABLE_THINKING),TC=r.type!=="disabled"&&!mT,PI=TC&&xb()&&iCt(U),Kh=PI?r.display:void 0,fy=void 0;',
    'mT=De(process.env.CLAUDE_CODE_DISABLE_THINKING),TC=r.type!=="disabled"&&!mT,PI=TC&&xb()&&iCt(U),Kh=PI?r.display??"summarized":void 0,fy=void 0;',
  ],
] as const) {
  test(`defaults eligible ${version} thinking requests to summarized display`, () => {
    const result = patchContents([source], { disable: disabledPatches });

    expect(result.contents[0]).toBe(expected);
    expect(result.patchResults.get("thinking-streaming")).toMatchObject({
      candidates: 1,
      patched: 1,
    });
  });
}
