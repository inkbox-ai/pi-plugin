// Render the sender's contribution without running HTML or fetching resources.
// A previous message quoted by the mail client is not a new instruction.
import { parse } from "parse5";

const ignored = new Set([
  "head",
  "script",
  "style",
  "template",
  "blockquote",
  "noscript",
  "svg",
]);
const blocks = new Set(["div", "p", "li", "br", "tr", "section", "pre", "hr"]);

export function authoredHtmlText(html) {
  if (typeof html !== "string" || !html || html.length > 512_000) return "";
  const pieces = [];
  const stack = [parse(html)];
  while (stack.length) {
    const node = stack.pop();
    if (node === null) {
      pieces.push("\n");
      continue;
    }
    if (node.nodeName === "#text") {
      pieces.push(node.value.replace(/\s+/g, " "));
      continue;
    }
    const attrs = Object.fromEntries(
      (node.attrs ?? []).map(({ name, value }) => [name, value]),
    );
    if (
      ignored.has(node.tagName) ||
      attrs.hidden !== undefined ||
      attrs["aria-hidden"] === "true" ||
      /(?:display\s*:\s*none|visibility\s*:\s*hidden|mso-hide\s*:\s*all)/i.test(
        attrs.style ?? "",
      ) ||
      /(?:gmail_quote|yahoo_quoted|moz-cite-prefix|protonmail_quote|gmail_signature)/i.test(
        attrs.class ?? "",
      )
    )
      continue;
    // Outlook appends original content after its reply/forward delimiter.
    if (/^(?:divRplyFwdMsg|appendonsend)$/i.test(attrs.id ?? "")) break;
    if (blocks.has(node.tagName)) {
      pieces.push("\n");
      stack.push(null);
    }
    const children = node.childNodes ?? [];
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
  }
  return pieces
    .join("")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n");
}
