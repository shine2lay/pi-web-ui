/**
 * mobile-fixes: HTML inside markdown (question dialogs, notes on presented files). Parsing HTML takes
 * a big library (parse5), so this is not part of the app's startup any more: Markdown.tsx loads it the
 * first time a text is shown with rawHtml.
 *
 * rehype-raw turns the HTML into the same tree markdown makes; rehype-sanitize (GitHub-style allow list)
 * right after it strips scripts, event attributes, iframes and the like: that HTML still comes from
 * the model.
 */
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import type { PluggableList } from "unified";

export const rawHtmlPlugins: PluggableList = [rehypeRaw, rehypeSanitize];
