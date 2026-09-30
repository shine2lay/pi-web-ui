/**
 * mobile-fixes: math in markdown (KaTeX: about a third of all the markdown code, plus its styles).
 * Not part of the app's startup any more: Markdown.tsx loads this the first time a text may hold math.
 */
import rehypeKatex from "rehype-katex";
import type { Pluggable } from "unified";
import "katex/dist/katex.min.css";

// A formula that doesn't parse shows as red source instead of breaking the message.
export const mathPlugin: Pluggable = [rehypeKatex, { strict: false, throwOnError: false }];
