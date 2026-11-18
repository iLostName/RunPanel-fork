"use client";

import { Fragment, useMemo } from "react";
import { Code } from "@/components/ui/Hint";
import { parseNotifyHtml, type NotifyNode } from "@/lib/notify-format";
import { cn } from "@/lib/utils";

/**
 * A notification's text, with its bold, its code and its links.
 *
 * Never `dangerouslySetInnerHTML`. The body is the small HTML dialect the
 * catalogue writes for Telegram, and its text comes from outside the panel —
 * commit subjects, error output, project names. It is parsed back into a tree
 * (`lib/notify-format.ts`) and drawn as elements, so whatever a commit subject
 * says, it arrives here as text.
 */
export function NotifyBody({ html, className }: { html: string; className?: string }) {
  const nodes = useMemo(() => parseNotifyHtml(html), [html]);
  if (nodes.length === 0) return null;
  return <div className={cn("break-words whitespace-pre-line", className)}>{draw(nodes, "")}</div>;
}

function draw(nodes: readonly NotifyNode[], prefix: string): React.ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${prefix}${index}`;
    if (typeof node === "string") return <Fragment key={key}>{node}</Fragment>;
    if (node.tag === "b") {
      return (
        <strong key={key} className="text-foreground font-medium">
          {draw(node.children, `${key}.`)}
        </strong>
      );
    }
    if (node.tag === "code") return <Code key={key}>{draw(node.children, `${key}.`)}</Code>;
    return (
      <a key={key} href={node.href} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
        {draw(node.children, `${key}.`)}
      </a>
    );
  });
}
