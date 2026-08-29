import Markdown from "react-markdown";

export function MarkdownBlock({ children, testId }: { children: string; testId?: string }) {
  return (
    <div
      className="font-reading text-sm text-(--text-primary) leading-relaxed space-y-2 [&_h1]:text-base [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold [&_h3]:text-sm [&_h3]:font-semibold [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4 [&_li]:my-0.5 [&_code]:font-mono [&_code]:text-xs [&_code]:bg-(--bg-subtle) [&_code]:px-1 [&_code]:rounded [&_blockquote]:border-l-2 [&_blockquote]:border-(--border) [&_blockquote]:pl-3 [&_blockquote]:text-(--text-tertiary)"
      data-testid={testId}
    >
      <Markdown>{children}</Markdown>
    </div>
  );
}
