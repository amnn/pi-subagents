import {
  Markdown,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type DefaultTextStyle,
} from "@mariozechner/pi-tui";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";

const MARKDOWN_RENDER_WIDTH = 100_000;
const SUMMARY_MAX_VISIBLE_CHARS = 240;
const SUMMARY_LINE_SEPARATOR = " · ";
const SUMMARY_TRUNCATION_SUFFIX = "…";
const FULL_RESET = "\x1b[0m";
const BACKGROUND_PRESERVING_RESET = "\x1b[22;23;24;25;27;28;29;39;54;55;59m";

function sanitizeRenderedLine(line: string): string {
  return line
    .replace(/\s+$/g, "")
    .replaceAll(FULL_RESET, BACKGROUND_PRESERVING_RESET);
}

export class Summarize implements Component {
  private readonly markdown: Markdown;

  constructor(
    text: string,
    private readonly prefix: string = "",
    defaultStyle?: DefaultTextStyle,
  ) {
    this.markdown = new Markdown(text, 0, 0, getMarkdownTheme(), defaultStyle);
  }

  render(width: number): string[] {
    const summary = this.markdown
      .render(MARKDOWN_RENDER_WIDTH)
      .map(sanitizeRenderedLine)
      .filter((line) => visibleWidth(line) > 0)
      .join(SUMMARY_LINE_SEPARATOR);

    const oneLine = this.prefix ? `${this.prefix} ${summary}` : summary;
    const clamped =
      visibleWidth(oneLine) > SUMMARY_MAX_VISIBLE_CHARS
        ? `${sanitizeRenderedLine(truncateToWidth(oneLine, SUMMARY_MAX_VISIBLE_CHARS - 1, ""))}${SUMMARY_TRUNCATION_SUFFIX}`
        : oneLine;

    return wrapTextWithAnsi(clamped, width);
  }

  invalidate(): void {
    this.markdown.invalidate();
  }
}
