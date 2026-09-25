import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const remarkPlugins = [remarkGfm];
const components: Components = {
  table: ({ children }) => (
    <div className="max-w-full overflow-x-auto" role="region" aria-label="Table" tabIndex={0}>
      <table className="w-full border-collapse text-left [&_th]:border [&_th]:border-(--border) [&_th]:bg-(--bg-subtle) [&_th]:px-3 [&_th]:py-2 [&_th]:font-semibold [&_th]:align-top [&_td]:border [&_td]:border-(--border) [&_td]:px-3 [&_td]:py-2 [&_td]:align-top">
        {children}
      </table>
    </div>
  ),
};

// `reading` is the long-answer register: a larger face held to the 65-character measure, so a
// wide pane never stretches the line. Tables keep the pane's width and scroll inside it.
// `sans` is for machinery rather than library: the assistant panel's help is app copy, and app
// copy is set in the interface face, not the reading one.
export function MarkdownBlock({ children, testId, reading = false, sans = false }: { children: string; testId?: string; reading?: boolean; sans?: boolean }) {
  return (
    <div
      className={`${sans ? "font-sans" : "font-reading"} ${reading ? "text-base [&>p]:max-w-prose [&>ul]:max-w-prose [&>ol]:max-w-prose [&>blockquote]:max-w-prose [&_table]:font-sans [&_table]:text-sm" : "text-sm"} text-(--text-primary) leading-relaxed space-y-2 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-semibold [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 [&_li]:my-0.5 [&_code]:font-mono [&_code]:text-xs [&_code]:bg-(--bg-subtle) [&_code]:px-1 [&_code]:rounded [&_blockquote]:border-l-2 [&_blockquote]:border-(--border) [&_blockquote]:pl-3 [&_blockquote]:text-(--text-tertiary)`}
      data-testid={testId}
    >
      <Markdown remarkPlugins={remarkPlugins} components={components}>{children}</Markdown>
    </div>
  );
}
