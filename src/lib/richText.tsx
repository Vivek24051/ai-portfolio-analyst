// Safe rendering of model text: a tiny subset of Markdown (paragraphs, bullet/numbered lists,
// **bold**) turned into React elements. No HTML is ever injected (no dangerouslySetInnerHTML),
// so model output or property text containing <script> renders as literal text.

import { Fragment, type ReactNode } from "react";

function inline(text: string, keyPrefix: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
      <strong key={`${keyPrefix}-${i}`}>{part.slice(2, -2)}</strong>
    ) : (
      <Fragment key={`${keyPrefix}-${i}`}>{part}</Fragment>
    ),
  );
}

const BULLET = /^\s*(?:[-•*]|\d+[.)])\s+/;

export function RichText({ text }: { text: string }) {
  const blocks = text.replace(/\r\n/g, "\n").trim().split(/\n{2,}/);
  return (
    <>
      {blocks.map((block, b) => {
        const lines = block.split("\n");
        if (lines.length > 0 && lines.every((l) => BULLET.test(l))) {
          const ordered = /^\s*\d/.test(lines[0]!);
          const items = lines.map((l, i) => <li key={i}>{inline(l.replace(BULLET, ""), `${b}-${i}`)}</li>);
          return ordered ? <ol key={b}>{items}</ol> : <ul key={b}>{items}</ul>;
        }
        return (
          <p key={b}>
            {lines.map((l, i) => (
              <Fragment key={i}>
                {i > 0 && <br />}
                {inline(l, `${b}-${i}`)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </>
  );
}
