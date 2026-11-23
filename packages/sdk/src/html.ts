/**
 * Python's `_html_to_text` (hai_agents_tools/otp.py). Its own module, outside `tools/` (whose every module is
 * a tool, re-exported whole by the main entry), so that the mirror test can import it without `hai-agents`
 * exporting it.
 */
export function htmlToText(markup: string): string {
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };
  return (
    markup
      .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi, " ")
      // Surface link targets: html mail hides the URL behind anchor text ("Click here").
      .replace(/<a\b[^>]*?href=["']([^"']+)["'][^>]*>/gi, " $1 ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, entity: string) => entities[entity] ?? " ")
  );
}
