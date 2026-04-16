import { createElement } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export default function MarkdownNotePreview({
  content,
  emptyMessage = "No note yet.",
  className = "node-note-markdown"
}) {
  const safeContent = String(content ?? "");
  if (!safeContent.trim()) {
    return createElement("div", { className: "queue-meta" }, emptyMessage);
  }

  return createElement(
    "div",
    { className },
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: [remarkGfm],
        components: {
          a: ({ ...props }) => createElement("a", { ...props, target: "_blank", rel: "noreferrer" })
        }
      },
      safeContent
    )
  );
}
