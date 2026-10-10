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

/** Splits a block into runs of list lines and plain lines, so "Heading:\n* a\n* b" renders a list. */
function runs(lines: string[]): Array<{ list: boolean; lines: string[] }> {
  const out: Array<{ list: boolean; lines: string[] }> = [];
  for (const line of lines) {
    const list = BULLET.test(line);
    const last = out[out.length - 1];
    if (last && last.list === list) last.lines.push(line);
    else out.push({ list, lines: [line] });
  }
  return out;
}

export function RichText({ text }: { text: string }) {
  const blocks = text.replace(/\r\n/g, "\n").trim().split(/\n{2,}/);
  return (
    <>
      {blocks.flatMap((block, b) =>
        runs(block.split("\n")).map((run, r) => {
          const key = `${b}-${r}`;
          if (run.list) {
            const ordered = /^\s*\d/.test(run.lines[0]!);
            const items = run.lines.map((l, i) => <li key={i}>{inline(l.replace(BULLET, ""), `${key}-${i}`)}</li>);
            return ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>;
          }
          return (
            <p key={key}>
              {run.lines.map((l, i) => (
                <Fragment key={i}>
                  {i > 0 && <br />}
                  {inline(l, `${key}-${i}`)}
                </Fragment>
              ))}
            </p>
          );
        }),
      )}
    </>
  );
}
