export function slackMrkdwn(text: string): string {
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, index) =>
      index % 2
        ? part
        : part
            .replace(
              /\[([^\]\n]+)\]\((https?:\/\/[^\s()<>]+)\)/g,
              (_match, label, url) =>
                `<${url.replaceAll("&", "&amp;")}|${label.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}>`,
            )
            .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
            .replace(/^#{1,6} (.+)$/gm, "*$1*"),
    )
    .join("");
}
