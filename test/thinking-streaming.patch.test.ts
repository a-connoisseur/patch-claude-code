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
  [
    "2.1.280",
    'Ub=De(process.env.CLAUDE_CODE_DISABLE_THINKING),Kg=r.type!=="disabled"&&!Ub,ic=Kg&&Ug()&&_Qt(_e),Vg=!ic?void 0:r.display==="highlights"&&rIr()?"omitted":r.display,yc=void 0;',
    'Ub=De(process.env.CLAUDE_CODE_DISABLE_THINKING),Kg=r.type!=="disabled"&&!Ub,ic=Kg&&Ug()&&_Qt(_e),Vg=!ic?void 0:r.display==="highlights"&&rIr()?"omitted":r.display??"summarized",yc=void 0;',
  ],
  [
    "2.1.281",
    'Zv=Oe(process.env.CLAUDE_CODE_DISABLE_THINKING),Ik=r.type!=="disabled"&&!Zv,p_=()=>w3e(_e)||Le!==void 0&&w3e(Le),Zl=Ik&&dg()&&ton(_e),Kg=!Zl?void 0:r.display==="highlights"&&DFr()?"omitted":r.display,zd=void 0;',
    'Zv=Oe(process.env.CLAUDE_CODE_DISABLE_THINKING),Ik=r.type!=="disabled"&&!Zv,p_=()=>w3e(_e)||Le!==void 0&&w3e(Le),Zl=Ik&&dg()&&ton(_e),Kg=!Zl?void 0:r.display==="highlights"&&DFr()?"omitted":r.display??"summarized",zd=void 0;',
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

test("preserves thinking eligibility and explicit display modes with highlight requests", () => {
  const source = 'let disabled=flag(process.env.CLAUDE_CODE_DISABLE_THINKING),enabled=config.type!=="disabled"&&!disabled,eligible=enabled&&provider()&&supports(model),display=!eligible?void 0:config.display==="highlights"&&highlights()?"omitted":config.display,request=void 0;return display;';
  const { contents: [patched] } = patchContents([source], { disable: disabledPatches });
  const getDisplay = new Function(
    "config", "process", "flag", "provider", "supports", "model", "highlights", patched
  );
  const evaluate = (
    config: { type: string; display?: string },
    { disabled = false, provider = true, supports = true, highlights = true } = {}
  ) => getDisplay(
    config,
    { env: { CLAUDE_CODE_DISABLE_THINKING: disabled } },
    Boolean,
    () => provider,
    () => supports,
    "test-model",
    () => highlights
  );

  expect(evaluate({ type: "enabled" })).toBe("summarized");
  expect(evaluate({ type: "disabled" })).toBeUndefined();
  expect(evaluate({ type: "enabled" }, { disabled: true })).toBeUndefined();
  expect(evaluate({ type: "enabled" }, { provider: false })).toBeUndefined();
  expect(evaluate({ type: "enabled" }, { supports: false })).toBeUndefined();
  expect(evaluate({ type: "enabled", display: "summarized" })).toBe("summarized");
  expect(evaluate({ type: "enabled", display: "omitted" })).toBe("omitted");
  expect(evaluate({ type: "enabled", display: "highlights" })).toBe("omitted");
  expect(evaluate({ type: "enabled", display: "highlights" }, { highlights: false })).toBe("highlights");
});
