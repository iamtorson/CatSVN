import { useEffect, useMemo, useState, type ReactNode, type UIEventHandler } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import type { Translation } from "./i18n";

export type PreviewFile = {
  path: string;
  content: string;
  size: number;
  is_binary: boolean;
  data_base64?: string | null;
};

export type PreviewerProps = { file: PreviewFile; t: Translation };

type Previewer = {
  id: string;
  match: (file: PreviewFile) => boolean;
  render: (props: PreviewerProps) => ReactNode;
};

const MAX_SHEET_ROWS = 400;
const MAX_SHEET_COLUMNS = 40;

const IMAGE_MIME: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
};

const SPREADSHEET_EXTENSIONS = new Set(["csv", "ods", "tsv", "xls", "xlsm", "xlsx"]);
const MARKDOWN_EXTENSIONS = new Set(["markdown", "md", "mdx"]);

function extensionOf(path: string): string {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

function bytesOf(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function arrayBufferOf(base64: string): ArrayBuffer {
  const bytes = bytesOf(base64);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(2)} MB`;
}

function MissingPayload({ t }: { t: Translation }) {
  return (
    <div className="preview-fallback">
      <p>{t.previewUnavailable}</p>
    </div>
  );
}

function ImagePreview({ file, t }: PreviewerProps) {
  const mime = IMAGE_MIME[extensionOf(file.path)] ?? "application/octet-stream";
  if (!file.data_base64) return <MissingPayload t={t} />;
  return (
    <div className="image-preview">
      <img
        alt={file.path}
        src={`data:${mime};base64,${file.data_base64}`}
      />
      <span className="preview-meta">{formatBytes(file.size)}</span>
    </div>
  );
}

function PdfPreview({ file, t }: PreviewerProps) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!file.data_base64) {
      setUrl(null);
      return;
    }
    const blob = new Blob([arrayBufferOf(file.data_base64)], {
      type: "application/pdf",
    });
    const objectUrl = URL.createObjectURL(blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file.data_base64]);

  if (!url) return <MissingPayload t={t} />;
  return (
    <div className="pdf-preview">
      <embed src={url} type="application/pdf" />
    </div>
  );
}

function MarkdownPreview({ file }: PreviewerProps) {
  return (
    <div className="markdown-preview">
      <Markdown
        components={{
          a: ({ children, href }) => (
            <a
              href={href}
              onClick={(event) => {
                event.preventDefault();
                if (href && /^https?:\/\//i.test(href)) void openUrl(href);
              }}
            >
              {children}
            </a>
          ),
        }}
        remarkPlugins={[remarkGfm]}
      >
        {file.content}
      </Markdown>
    </div>
  );
}

function DocxPreview({ file, t }: PreviewerProps) {
  const [html, setHtml] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setHtml("");
    setFailed(false);
    if (!file.data_base64) {
      setFailed(true);
      return;
    }
    mammoth
      .convertToHtml({ arrayBuffer: arrayBufferOf(file.data_base64) })
      .then((result) => {
        if (!cancelled) setHtml(result.value);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [file.data_base64]);

  if (failed) return <MissingPayload t={t} />;
  if (!html) {
    return (
      <div className="preview-fallback">
        <p>{t.renderingPreview}</p>
      </div>
    );
  }
  return (
    <div
      className="docx-preview"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function SpreadsheetPreview({ file, t }: PreviewerProps) {
  const [error, setError] = useState(false);
  const [active, setActive] = useState(0);

  const sheets = useMemo(() => {
    try {
      setError(false);
      const workbook = file.is_binary
        ? XLSX.read(bytesOf(file.data_base64 ?? ""), { type: "array" })
        : XLSX.read(file.content, { type: "string" });
      return workbook.SheetNames.slice(0, 12).map((name) => {
        const rows = XLSX.utils
          .sheet_to_json<unknown[]>(workbook.Sheets[name], {
            header: 1,
            blankrows: false,
            defval: "",
            raw: false,
          })
          .slice(0, MAX_SHEET_ROWS)
          .map((row) =>
            row
              .slice(0, MAX_SHEET_COLUMNS)
              .map((cell) => (cell == null ? "" : String(cell))),
          );
        return { name, rows };
      });
    } catch {
      setError(true);
      return [];
    }
  }, [file.content, file.data_base64, file.is_binary]);

  if (error || sheets.length === 0) return <MissingPayload t={t} />;
  const current = sheets[Math.min(active, sheets.length - 1)];

  return (
    <div className="sheet-preview">
      {sheets.length > 1 && (
        <div className="sheet-tabs">
          {sheets.map((sheet, index) => (
            <button
              className={index === active ? "active" : ""}
              key={sheet.name}
              onClick={() => setActive(index)}
              type="button"
            >
              {sheet.name}
            </button>
          ))}
        </div>
      )}
      <div className="sheet-table">
        <table>
          <tbody>
            {current.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {current.rows.length >= MAX_SHEET_ROWS && (
        <p className="preview-note">
          {t.sheetTruncated(MAX_SHEET_ROWS, MAX_SHEET_COLUMNS)}
        </p>
      )}
    </div>
  );
}

/**
 * Preview plugin registry. To support another format, append an entry: `match`
 * decides when it applies, `render` returns the preview body. The first match
 * wins, so specialised previewers must come before generic ones.
 */
export const previewers: Previewer[] = [
  {
    id: "image",
    match: (file) => extensionOf(file.path) in IMAGE_MIME,
    render: (props) => <ImagePreview {...props} />,
  },
  {
    id: "pdf",
    match: (file) => extensionOf(file.path) === "pdf",
    render: (props) => <PdfPreview {...props} />,
  },
  {
    id: "markdown",
    match: (file) => MARKDOWN_EXTENSIONS.has(extensionOf(file.path)),
    render: (props) => <MarkdownPreview {...props} />,
  },
  {
    id: "docx",
    match: (file) => extensionOf(file.path) === "docx",
    render: (props) => <DocxPreview {...props} />,
  },
  {
    id: "spreadsheet",
    match: (file) => SPREADSHEET_EXTENSIONS.has(extensionOf(file.path)),
    render: (props) => <SpreadsheetPreview {...props} />,
  },
];

export function resolvePreviewer(file: PreviewFile): Previewer | undefined {
  return previewers.find((previewer) => previewer.match(file));
}

export function PreviewPane({
  file,
  onScroll,
  t,
}: {
  file: PreviewFile;
  onScroll?: UIEventHandler<HTMLElement>;
  t: Translation;
}) {
  const previewer = resolvePreviewer(file);
  if (!previewer) {
    return (
      <pre className="file-view" onScroll={onScroll}>
        {file.content || t.noTextContent}
      </pre>
    );
  }
  return (
    <div
      className={`file-view rich-preview ${previewer.id}-preview`}
      onScroll={onScroll}
    >
      {previewer.render({ file, t })}
    </div>
  );
}
