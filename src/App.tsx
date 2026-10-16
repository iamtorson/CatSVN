import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type UIEvent as ReactUIEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open } from "@tauri-apps/plugin-dialog";
import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  ChevronUp,
  Database,
  Download,
  Eye,
  ExternalLink,
  FilePlus,
  FileText,
  Folder,
  FolderPlus,
  GitCompare,
  History,
  Loader2,
  LogOut,
  Pencil,
  RefreshCw,
  Save,
  Trash2,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import { detectLocale, localeNames, translations, type Locale } from "./i18n";
import "./App.css";

type RepoInfo = {
  root_url: string;
  workdir: string;
  revision: number;
};

type SvnEntry = {
  name: string;
  path: string;
  kind: "dir" | "file" | string;
  size: number | null;
  revision: number | null;
  author: string | null;
  date: string | null;
  checked_out: boolean;
};

type FileContent = {
  path: string;
  content: string;
  size: number;
  is_binary: boolean;
};

type SavedFile = {
  changed: boolean;
  diff: string;
};

type SavedCredentials = {
  username: string;
  has_password: boolean;
};

type UploadedEntry = {
  path: string;
  commit_path: string;
  kind: string;
  source_path: string;
};

type LocalChange = {
  path: string;
  commit_path: string;
  status: string;
  kind: string;
};

type HistoryChangedPath = {
  path: string;
  action: string;
  kind: string | null;
};

type HistoryEntry = {
  revision: number;
  author: string | null;
  date: string | null;
  message: string | null;
  changed_paths: HistoryChangedPath[];
};

type HistoryDiff = {
  output: string;
  truncated: boolean;
  byte_size: number;
};

type FileTab = "preview" | "edit" | "diff";

type BrowseMode = "remote" | "local";
type CheckoutMode = "files" | "subfolders" | "all" | "custom";
type NavEntry = { path: string; mode: BrowseMode };

const HISTORY_LIMIT = 200;

function formatDate(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatBytes(size: number | null | undefined): string {
  if (size == null) return "-";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function parentPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function sourceName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}

function defaultWorkdir(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/\./g, "-") || "local";
    return `~/CatSVN-workspaces/${host}`;
  } catch {
    return "~/CatSVN-workspaces/repository";
  }
}

async function runCommand<T>(command: string, args: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args);
}

const SIDEBAR_DEFAULT_WIDTH = 420;
const SIDEBAR_MIN_WIDTH = 300;
const SIDEBAR_MAX_WIDTH = 680;

type SegmentOption<T extends string> = {
  value: T;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
};

// Liquid-glass segmented control: one translucent thumb slides between equal
// segments, so the selection reads as a piece of glass moving under the labels
// instead of a button that repaints in place.
function Segmented<T extends string>({
  ariaLabel,
  className,
  onChange,
  options,
  value,
}: {
  ariaLabel?: string;
  className: string;
  onChange: (value: T) => void;
  options: SegmentOption<T>[];
  value: T;
}) {
  const index = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  return (
    <div
      aria-label={ariaLabel}
      className={`seg-control ${className}`}
      role="group"
      style={
        {
          "--seg-count": options.length,
          "--seg-index": index,
        } as CSSProperties
      }
    >
      <span aria-hidden className="seg-thumb" />
      {options.map((option) => (
        <button
          className={option.value === value ? "active" : ""}
          disabled={option.disabled}
          key={option.value}
          onClick={() => onChange(option.value)}
          type="button"
        >
          {option.icon}
          {option.label}
        </button>
      ))}
    </div>
  );
}

function readSidebarWidth(key: string): number {
  const width = Number(localStorage.getItem(key));
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));
}

export default function App() {
  const [rootUrl, setRootUrl] = useState(() => localStorage.getItem("svn-lens:url") ?? "");
  const [workdir, setWorkdir] = useState(() => localStorage.getItem("svn-lens:workdir") ?? "");
  const [username, setUsername] = useState(
    () => localStorage.getItem("svn-lens:username") ?? "",
  );
  const [password, setPassword] = useState("");
  const [rememberPassword, setRememberPassword] = useState(false);
  const [hasSavedPassword, setHasSavedPassword] = useState(false);
  const [autoLogin, setAutoLogin] = useState(
    () => localStorage.getItem("svn-lens:auto-login") === "1",
  );
  const [repo, setRepo] = useState<RepoInfo | null>(null);
  const [path, setPath] = useState("");
  const [entries, setEntries] = useState<SvnEntry[]>([]);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<SvnEntry | null>(null);
  const [preview, setPreview] = useState<FileContent | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [diff, setDiff] = useState("");
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<FileTab>("preview");
  const [commitMessage, setCommitMessage] = useState("");
  const [uploadCommitMessage, setUploadCommitMessage] = useState("");
  const [pendingUploads, setPendingUploads] = useState<UploadedEntry[]>([]);
  const [localChanges, setLocalChanges] = useState<LocalChange[]>([]);
  const [browseMode, setBrowseMode] = useState<BrowseMode>("remote");
  const [checkoutTarget, setCheckoutTarget] = useState("");
  const [checkoutMode, setCheckoutMode] = useState<CheckoutMode>("files");
  const [checkoutLevels, setCheckoutLevels] = useState(2);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [excludeTarget, setExcludeTarget] = useState("");
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyTarget, setHistoryTarget] = useState("");
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [historyDiff, setHistoryDiff] = useState<HistoryDiff | null>(null);
  const [historyDiffLoading, setHistoryDiffLoading] = useState(false);
  const [historyDiffError, setHistoryDiffError] = useState("");
  const [selectedHistoryRevision, setSelectedHistoryRevision] = useState<
    number | null
  >(null);
  const [hoveredPath, setHoveredPath] = useState<string | null>(null);
  const [deletingPath, setDeletingPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [locale, setLocale] = useState<Locale>(() => detectLocale());
  const [leftWidth, setLeftWidth] = useState(() =>
    readSidebarWidth("svn-lens:left-width:v2"),
  );
  const [rightWidth, setRightWidth] = useState(() =>
    readSidebarWidth("svn-lens:right-width:v2"),
  );
  const [resizingSidebar, setResizingSidebar] = useState<
    | null
    | {
        side: "left" | "right";
        startMouseX: number;
        startWidth: number;
      }
  >(null);

  // Which scroll regions are currently moved away from the top; the frosted
  // headers pick up a lift while their own list is scrolled underneath.
  const [scrolled, setScrolled] = useState({ list: false, file: false, changes: false });
  const trackScroll = (key: "list" | "file" | "changes") => (event: ReactUIEvent<HTMLElement>) => {
    const next = event.currentTarget.scrollTop > 1;
    setScrolled((prev) => (prev[key] === next ? prev : { ...prev, [key]: next }));
  };

  useEffect(() => {
    setScrolled((prev) => (prev.file ? { ...prev, file: false } : prev));
  }, [tab, selected?.path]);

  const workdirPlaceholder = useMemo(() => defaultWorkdir(rootUrl), [rootUrl]);
  const visibleEntries = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return entries;
    return entries.filter((entry) => entry.name.toLowerCase().includes(query));
  }, [entries, filter]);
  const t = translations[locale];

  useEffect(() => {
    localStorage.setItem("svn-lens:auto-login", autoLogin ? "1" : "0");
  }, [autoLogin]);

  useEffect(() => {
    localStorage.setItem("svn-lens:locale", locale);
  }, [locale]);

  useEffect(() => {
    void getCurrentWebviewWindow().setTheme(null);
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setCheckoutOpen(false);
      setExcludeTarget("");
      setHistoryOpen(false);
      setContextMenu(null);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const closeOnOutsidePress = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".context-menu")) return;
      setContextMenu(null);
    };
    const close = () => setContextMenu(null);
    window.addEventListener("mousedown", closeOnOutsidePress);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("mousedown", closeOnOutsidePress);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    localStorage.setItem("svn-lens:left-width:v2", String(leftWidth));
    localStorage.setItem("svn-lens:right-width:v2", String(rightWidth));
  }, [leftWidth, rightWidth]);

  useEffect(() => {
    if (!resizingSidebar) return;

    const handleMouseMove = (event: MouseEvent) => {
      const delta = event.clientX - resizingSidebar.startMouseX;
      const nextWidth =
        resizingSidebar.side === "left"
          ? resizingSidebar.startWidth + delta
          : resizingSidebar.startWidth - delta;
      const width = Math.min(
        SIDEBAR_MAX_WIDTH,
        Math.max(SIDEBAR_MIN_WIDTH, nextWidth),
      );

      if (resizingSidebar.side === "left") {
        setLeftWidth(width);
      } else {
        setRightWidth(width);
      }
    };

    const stopResizing = () => setResizingSidebar(null);

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", stopResizing);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", stopResizing);
    };
  }, [resizingSidebar]);

  const loadLocalChanges = useCallback(async () => {
    const changes = await runCommand<LocalChange[]>("list_local_changes", {});
    setLocalChanges(changes);
    setPendingUploads((current) => {
      // Drop uploads that were committed or reverted outside the current list.
      const addedPaths = new Set(
        changes
          .filter((change) => change.status === "added")
          .map((change) => change.path),
      );
      const retained = current.filter((upload) => addedPaths.has(upload.commit_path));
      const unfinishedUploads = changes
        .filter((change) => change.status === "added" && change.path === change.commit_path)
        .filter((change) => !retained.some((upload) => upload.path === change.path))
        .map((change) => ({
          path: change.path,
          commit_path: change.commit_path,
          kind: change.kind,
          source_path: "",
        }));
      return unfinishedUploads.length ? [...retained, ...unfinishedUploads] : retained;
    });
    return changes;
  }, []);

  const discardChange = useCallback(async (path: string, status: string) => {
    const changeKey = `${status}:${path}`;
    setDeletingPath(changeKey);
    setError("");
    setNotice("");
    try {
      await runCommand<void>("discard_local_change", { path, status });
      setPendingUploads((current) =>
        current.filter((upload) => upload.path !== path),
      );
      setLocalChanges((current) =>
        current.filter((change) => `${change.status}:${change.path}` !== changeKey),
      );
      setHoveredPath((current) => (current === path ? null : current));
      setNotice(t.discardedLocally(path));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingPath(null);
    }
  }, [t]);

  const openHistory = useCallback(async (targetPath: string) => {
    setHistoryOpen(true);
    setHistoryTarget(targetPath);
    setHistoryEntries([]);
    setHistoryError("");
    setHistoryDiff(null);
    setHistoryDiffError("");
    setHistoryDiffLoading(false);
    setSelectedHistoryRevision(null);
    setHistoryLoading(true);

    try {
      const entries = await runCommand<HistoryEntry[]>("list_history", {
        path: targetPath,
        limit: HISTORY_LIMIT,
      });
      setHistoryEntries(entries);
    } catch (err) {
      setHistoryError(err instanceof Error ? err.message : String(err));
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const refreshHistory = useCallback(async () => {
    if (!historyOpen) return;
    await openHistory(historyTarget);
  }, [historyOpen, historyTarget, openHistory]);

  const diffHistoryRevision = useCallback(
    async (revision: number) => {
      setSelectedHistoryRevision(revision);
      setHistoryDiff(null);
      setHistoryDiffError("");
      setHistoryDiffLoading(true);
      try {
        const result = await runCommand<HistoryDiff>("diff_history_with_latest", {
          path: historyTarget,
          revision,
        });
        setHistoryDiff(result);
      } catch (err) {
        setHistoryDiffError(err instanceof Error ? err.message : String(err));
      } finally {
        setHistoryDiffLoading(false);
      }
    },
    [historyTarget],
  );

  const loadSavedCredentials = useCallback(async (repositoryUrl: string) => {
    const saved = await runCommand<SavedCredentials | null>("load_saved_credentials", {
      rootUrl: repositoryUrl.trim(),
    });
    if (saved?.has_password) {
      if (saved.username) setUsername(saved.username);
      setRememberPassword(true);
      setHasSavedPassword(true);
    }
  }, []);

  const loadRequestId = useRef(0);
  const entryListRef = useRef<HTMLDivElement | null>(null);

  const handleEntryListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const isArrowUp = event.key === "ArrowUp";
    const isArrowDown = event.key === "ArrowDown";
    const isHome = event.key === "Home";
    const isEnd = event.key === "End";
    if (!isArrowUp && !isArrowDown && !isHome && !isEnd) return;
    const rows = Array.from(
      entryListRef.current?.querySelectorAll<HTMLElement>(".entry-row") ?? [],
    );
    const index = rows.findIndex((row) => row === document.activeElement);
    if (index === -1) return;
    event.preventDefault();
    const nextIndex = isHome
      ? 0
      : isEnd
        ? rows.length - 1
        : isArrowDown
          ? Math.min(rows.length - 1, index + 1)
          : Math.max(0, index - 1);
    rows[nextIndex]?.focus();
  };

  const loadDirectory = useCallback(async (targetPath: string, mode = browseMode) => {
    const requestId = loadRequestId.current + 1;
    loadRequestId.current = requestId;
    setError("");
    setNotice("");
    setSelected(null);
    setPreview(null);
    setDraft(null);
    setDiff("");
    setDirty(false);
    setTab("preview");
    setFilter("");
    setLoading(true);

    try {
      const result =
        mode === "local"
          ? await runCommand<SvnEntry[]>("list_local_entries", { path: targetPath })
          : await runCommand<SvnEntry[]>("list_path", { path: targetPath });
      if (loadRequestId.current !== requestId) return;
      setEntries(result);
      setPath(targetPath);
    } catch (err) {
      if (loadRequestId.current !== requestId) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (loadRequestId.current === requestId) setLoading(false);
    }
  }, [browseMode]);

  // Directory history. `navigateTo` records a step, while a plain
  // `loadDirectory` refresh keeps the current step in place; back and forward
  // walk the recorded steps.
  const navStackRef = useRef<NavEntry[]>([{ path: "", mode: "remote" }]);
  const navIndexRef = useRef(0);
  const [navCursor, setNavCursor] = useState({ index: 0, length: 1 });

  const syncNavCursor = () => {
    setNavCursor({ index: navIndexRef.current, length: navStackRef.current.length });
  };

  const resetNavigation = () => {
    navStackRef.current = [{ path: "", mode: "remote" }];
    navIndexRef.current = 0;
    setBrowseMode("remote");
    syncNavCursor();
  };

  const applyNavEntry = useCallback(
    async (index: number) => {
      const entry = navStackRef.current[index];
      if (!entry) return;
      navIndexRef.current = index;
      setNavCursor({ index, length: navStackRef.current.length });
      setBrowseMode(entry.mode);
      await loadDirectory(entry.path, entry.mode);
    },
    [loadDirectory],
  );

  const navigateTo = useCallback(
    async (targetPath: string, mode: BrowseMode = browseMode) => {
      const stack = navStackRef.current.slice(0, navIndexRef.current + 1);
      const last = stack[stack.length - 1];
      if (!(last.path === targetPath && last.mode === mode)) {
        stack.push({ path: targetPath, mode });
      }
      navStackRef.current = stack;
      navIndexRef.current = stack.length - 1;
      setNavCursor({ index: navIndexRef.current, length: stack.length });
      // Mirror the step into the webview history: macOS routes mouse side
      // buttons and trackpad swipes onto back/forward, which arrives as popstate.
      window.history.pushState({ catsvnNav: navIndexRef.current }, "");
      setBrowseMode(mode);
      await loadDirectory(targetPath, mode);
    },
    [browseMode, loadDirectory],
  );

  const goBack = useCallback(async () => {
    if (navIndexRef.current <= 0) return;
    await applyNavEntry(navIndexRef.current - 1);
  }, [applyNavEntry]);

  const goForward = useCallback(async () => {
    if (navIndexRef.current >= navStackRef.current.length - 1) return;
    await applyNavEntry(navIndexRef.current + 1);
  }, [applyNavEntry]);

  const switchBrowseMode = useCallback(
    async (mode: BrowseMode) => {
      await navigateTo(path, mode);
    },
    [navigateTo, path],
  );

  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      const state = event.state as { catsvnNav?: number } | null;
      const index = typeof state?.catsvnNav === "number" ? state.catsvnNav : 0;
      // The side button is handled here first, so skip the echoed navigation
      // instead of stepping twice.
      if (index === navIndexRef.current) return;
      void applyNavEntry(index);
    };
    const handleMouseButton = (event: MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return;
      event.preventDefault();
      if (event.button === 3) {
        void goBack();
      } else {
        void goForward();
      }
    };
    const handleNavKeys = (event: KeyboardEvent) => {
      if (!event.metaKey || event.altKey || event.ctrlKey) return;
      if (event.key === "[") {
        event.preventDefault();
        void goBack();
      } else if (event.key === "]") {
        event.preventDefault();
        void goForward();
      }
    };
    window.addEventListener("popstate", handlePopState);
    window.addEventListener("mouseup", handleMouseButton);
    window.addEventListener("keydown", handleNavKeys);
    return () => {
      window.removeEventListener("popstate", handlePopState);
      window.removeEventListener("mouseup", handleMouseButton);
      window.removeEventListener("keydown", handleNavKeys);
    };
  }, [applyNavEntry, goBack, goForward]);

  const checkoutDirectory = useCallback(async () => {
    setCheckoutLoading(true);
    setError("");
    try {
      await runCommand<void>("checkout_directory", {
        path: checkoutTarget,
        mode: checkoutMode,
        levels: checkoutLevels,
      });
      setCheckoutOpen(false);
      await navigateTo(path, "local");
      await loadLocalChanges();
      setNotice(t.checkoutCompleted);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCheckoutLoading(false);
    }
  }, [
    checkoutLevels,
    checkoutMode,
    checkoutTarget,
    loadLocalChanges,
    navigateTo,
    path,
    t,
  ]);

  const openCheckout = useCallback((targetPath: string) => {
    setCheckoutTarget(targetPath);
    setCheckoutMode("files");
    setCheckoutLevels(2);
    setCheckoutOpen(true);
  }, []);

  const confirmExcludeCheckout = useCallback(async () => {
    if (!excludeTarget) return;
    setError("");
    setLoading(true);
    try {
      await runCommand<void>("exclude_checkout", { path: excludeTarget });
      await Promise.all([loadDirectory(path, browseMode), loadLocalChanges()]);
      setExcludeTarget("");
      setNotice(t.checkoutRemoved(excludeTarget));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [browseMode, excludeTarget, loadDirectory, loadLocalChanges, path, t]);

  const uploadDroppedPaths = useCallback(async (droppedPaths: string[]) => {
    if (!droppedPaths.length) return;

    const staged: UploadedEntry[] = [];
    const failures: string[] = [];
    setLoading(true);

    for (const sourcePath of droppedPaths) {
      try {
        const uploaded = await runCommand<UploadedEntry>("upload_to_working_copy", {
          destinationDir: path,
          sourcePath,
        });
        if (!staged.some((entry) => entry.path === uploaded.path)) {
          staged.push(uploaded);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push(`${sourceName(sourcePath)}: ${message}`);
      }
    }

    if (staged.length) {
      setPendingUploads((current) => {
        const next = [...current];
        for (const upload of staged) {
          if (!next.some((entry) => entry.path === upload.path)) {
            next.push(upload);
          }
        }
        return next;
      });
      await loadLocalChanges();
    }

    if (failures.length) {
      setError(failures.join("\n"));
    }
    if (staged.length) {
      setNotice(
        staged.length === 1
          ? t.stagedLocally(staged[0].path)
          : t.itemsStaged(staged.length),
      );
    }
    setLoading(false);
  }, [loadLocalChanges, path, t]);

  const startSidebarResize = (
    event: React.PointerEvent<HTMLDivElement>,
    side: "left" | "right",
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizingSidebar({
      side,
      startMouseX: event.clientX,
      startWidth: side === "left" ? leftWidth : rightWidth,
    });
  };

  const resizeSidebar = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!resizingSidebar || event.buttons !== 1) return;
    const delta = event.clientX - resizingSidebar.startMouseX;
    const nextWidth =
      resizingSidebar.side === "left"
        ? resizingSidebar.startWidth + delta
        : resizingSidebar.startWidth - delta;
    const width = Math.min(
      SIDEBAR_MAX_WIDTH,
      Math.max(SIDEBAR_MIN_WIDTH, nextWidth),
    );

    if (resizingSidebar.side === "left") {
      setLeftWidth(width);
    } else {
      setRightWidth(width);
    }
  };

  const stopSidebarResize = () => setResizingSidebar(null);

  const resetSidebarWidth = (side: "left" | "right") => {
    if (side === "left") {
      setLeftWidth(SIDEBAR_DEFAULT_WIDTH);
    } else {
      setRightWidth(SIDEBAR_DEFAULT_WIDTH);
    }
  };

  async function connectRepository(
    event?: React.FormEvent,
    overrides?: {
      rootUrl?: string;
      workdir?: string;
      username?: string;
      remember?: boolean;
      automatic?: boolean;
    },
  ) {
    event?.preventDefault();
    setError("");
    if (!overrides?.automatic) setNotice("");
    setLoading(true);

    try {
      const targetRootUrl = (overrides?.rootUrl ?? rootUrl).trim();
      const targetWorkdir =
        (overrides?.workdir ?? workdir).trim() || defaultWorkdir(targetRootUrl);
      const targetUsername = overrides?.username ?? username.trim();
      const targetRemember = overrides?.remember ?? rememberPassword;
      const info = await runCommand<RepoInfo>("connect_repository", {
        rootUrl: targetRootUrl,
        workdir: targetWorkdir,
        username: targetUsername || null,
        password: password || null,
        rememberCredentials: targetRemember,
      });
      localStorage.setItem("svn-lens:url", info.root_url);
      localStorage.setItem("svn-lens:workdir", info.workdir);
      localStorage.setItem("svn-lens:username", targetUsername);
      setWorkdir(info.workdir);
      setRepo(info);
      setRootUrl(info.root_url);
      setPendingUploads([]);
      setPassword("");
      const saved = await runCommand<SavedCredentials | null>("load_saved_credentials", {
        rootUrl: info.root_url,
      });
      setHasSavedPassword(Boolean(saved?.has_password));
      resetNavigation();
      await Promise.all([loadDirectory("", "remote"), loadLocalChanges()]);
      setNotice(
        overrides?.automatic
          ? t.autoConnectedAt(info.revision)
          : t.connectedAt(info.revision),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function refreshRepository() {
    if (!repo) return;
    try {
      const info = await runCommand<RepoInfo>("refresh_repository", {});
      setRepo(info);
      await Promise.all([loadDirectory(path), loadLocalChanges()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Refreshing a folder in the local view has to update the working copy: a
  // plain re-listing would keep showing the stale files that are already on
  // disk. A plain `svn update` keeps the sparse depth untouched and only pulls
  // the newest content for the items that are checked out.
  async function reloadDirectory() {
    setError("");
    setLoading(true);
    try {
      if (browseMode === "local") {
        await runCommand<void>("update_directory", { path });
      }
      await Promise.all([loadDirectory(path, browseMode), loadLocalChanges()]);
      if (browseMode === "local") setNotice(t.directoryRefreshed);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function disconnectRepository() {
    setError("");
    setNotice("");
    try {
      await runCommand<void>("disconnect_repository", {});
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setRepo(null);
    setPath("");
    setEntries([]);
    setSelected(null);
    setPreview(null);
    setDraft(null);
    setDiff("");
    setDirty(false);
    setPendingUploads([]);
    setLocalChanges([]);
    setCheckoutOpen(false);
    setExcludeTarget("");
    setHistoryOpen(false);
    resetNavigation();
  }

  useEffect(() => {
    const savedUrl = localStorage.getItem("svn-lens:url");
    const savedWorkdir = localStorage.getItem("svn-lens:workdir");
    if (!savedUrl || !savedWorkdir) return;

    const runStartupLogin = async () => {
      const saved = await runCommand<SavedCredentials | null>("load_saved_credentials", {
        rootUrl: savedUrl,
      });
      if (!saved?.has_password) return;

      if (saved.username) setUsername(saved.username);
      setRememberPassword(true);
      setHasSavedPassword(true);
      if (!autoLogin) return;

      await connectRepository(
        undefined,
        {
          rootUrl: savedUrl,
          workdir: savedWorkdir,
          username: saved.username,
          remember: true,
          automatic: true,
        },
      );
    };

    runStartupLogin().catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [autoLogin]);

  async function uploadSelection(kind: "file" | "folder") {
    const selection = await open({
      directory: kind === "folder",
      multiple: false,
      title: kind === "folder" ? t.selectFolderUpload : t.selectFileUpload,
    });
    if (typeof selection !== "string" || !selection) return;

    setError("");
    setNotice("");
    setLoading(true);
    try {
      const uploaded = await runCommand<UploadedEntry>("upload_to_working_copy", {
        destinationDir: path,
        sourcePath: selection,
      });
      setPendingUploads((current) =>
        current.some((entry) => entry.path === uploaded.path) ? current : [...current, uploaded],
      );
      await loadLocalChanges();
      setNotice(t.stagedLocally(uploaded.path));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function commitPendingUploads() {
    if (!pendingUploads.length) return;
    if (!uploadCommitMessage.trim()) {
      setError(t.commitMessageRequired);
      return;
    }

    setError("");
    setLoading(true);
    try {
      const output = await runCommand<string>("commit_paths", {
        paths: pendingUploads.map((entry) => entry.commit_path),
        message: uploadCommitMessage.trim(),
      });
      setPendingUploads([]);
      setUploadCommitMessage("");
      await refreshRepository();
      setNotice(output.trim() || t.uploadsCommitted);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function previewEntry(entry: SvnEntry) {
    if (entry.kind !== "file") return;
    setError("");
    setNotice("");
    setLoading(true);
    setSelected(entry);
    setTab("preview");

    try {
      const content = await runCommand<FileContent>("preview_file", { path: entry.path });
      setPreview(content);
      // Binary previews come back as an empty string; keep the draft null so the
      // editor and "save" stay unavailable instead of writing an empty file.
      setDraft(content.is_binary ? null : content.content);
      setDirty(false);
      setDiff("");
    } catch (err) {
      setPreview(null);
      setDraft(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  function markCheckedOutLocally(target: string) {
    setEntries((current) =>
      current.map((item) => (item.path === target ? { ...item, checked_out: true } : item)),
    );
    setSelected((current) =>
      current && current.path === target ? { ...current, checked_out: true } : current,
    );
  }

  async function openEditor(entry: SvnEntry) {
    if (entry.kind !== "file") return;
    setError("");
    setNotice("");
    setLoading(true);
    setSelected(entry);

    try {
      const content = await runCommand<FileContent>("open_for_edit", { path: entry.path });
      setPreview(content);
      setDraft(content.is_binary ? null : content.content);
      setDirty(false);
      setDiff("");
      if (content.is_binary) {
        setTab("preview");
        setNotice(t.binaryFetched);
      } else {
        setTab("edit");
        setNotice(t.fetchedOnlyThisFile);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      // `open_for_edit` fetches the file before it can fail on binary content, so
      // the file is on disk either way and can be opened externally.
      markCheckedOutLocally(entry.path);
      setLoading(false);
    }
  }

  async function openLocalFile() {
    if (!selected) return;
    setError("");
    try {
      await runCommand<void>("open_local_path", { path: selected.path });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function saveCurrentFile(): Promise<SavedFile | null> {
    if (!selected || draft == null) return null;
    setError("");
    setLoading(true);

    try {
      const result = await runCommand<SavedFile>("save_file", {
        path: selected.path,
        content: draft,
      });
      setDiff(result.diff);
      setDirty(result.changed);
      if (result.changed) {
        setTab("diff");
        setNotice(t.changesSavedLocally);
      }
      return result;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function showDiff() {
    setTab("diff");
    if (!selected) return;
    setError("");
    setLoading(true);
    try {
      setDiff(await runCommand<string>("file_diff", { path: selected.path }));
    } catch (err) {
      setDiff("");
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function refreshFile() {
    if (!selected) return;
    setError("");
    setLoading(true);
    try {
      const content = await runCommand<FileContent>("update_file", { path: selected.path });
      setPreview(content);
      setDraft(content.is_binary ? null : content.content);
      setTab("preview");
      // Re-read the diff too: a file may have been changed outside the app
      // (a document edited in Word, for example), and that still needs committing.
      const output = await runCommand<string>("file_diff", { path: selected.path });
      setDiff(output);
      setDirty(output.trim().length > 0);
      setNotice(t.fileRefreshed);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function discardFile() {
    if (!selected) return;
    setError("");
    setLoading(true);
    try {
      const content = await runCommand<FileContent>("discard_changes", { path: selected.path });
      setPreview(content);
      setDraft(content.is_binary ? null : content.content);
      setDirty(false);
      setDiff("");
      setTab("preview");
      setNotice(t.localChangesReverted);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function commitCurrentFile() {
    if (!selected) return;
    if (!commitMessage.trim()) {
      setError(t.commitMessageRequired);
      return;
    }

    // A draft that failed to save must not fall through to a commit, otherwise
    // the commit would ship whatever stale content is still on disk.
    if (draft != null) {
      const saved = await saveCurrentFile();
      if (!saved) return;
      if (!saved.changed) {
        setNotice(t.noLocalChangesToCommit);
        return;
      }
    }

    setError("");
    setLoading(true);
    try {
      const output = await runCommand<string>("commit_file", {
        path: selected.path,
        message: commitMessage.trim(),
      });
      setDirty(false);
      setDiff("");
      setCommitMessage("");
      setNotice(output.trim() || t.committedSuccessfully);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!workdir && rootUrl) {
      setWorkdir(defaultWorkdir(rootUrl));
    }
  }, [rootUrl, workdir]);

  useEffect(() => {
    if (!repo) return;

    let disposed = false;
    let stopListening: (() => void) | undefined;

    void getCurrentWebviewWindow()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") {
          setDragActive(true);
          return;
        }
        if (payload.type === "leave") {
          setDragActive(false);
          return;
        }
        if (payload.type === "drop") {
          setDragActive(false);
          void uploadDroppedPaths(payload.paths ?? []);
        }
      })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          stopListening = unlisten;
        }
      });

    return () => {
      disposed = true;
      stopListening?.();
    };
  }, [repo, uploadDroppedPaths]);

  const breadcrumbs = path ? path.split("/").filter(Boolean) : [];

  return (
    <div
      className="app-shell"
      onContextMenu={(event) => {
        const target = event.target as HTMLElement;
        // Keep the native menu where text is edited or selected so copy and
        // paste keep working, and replace it everywhere else: the WebView adds
        // a "Reload" entry that would throw the whole workspace away.
        if (target.closest("input, textarea, pre, code, [contenteditable='true']")) {
          return;
        }
        const selection = window.getSelection();
        if (selection && !selection.isCollapsed) return;
        event.preventDefault();
        if (!repo || !target.closest(".browser-panel")) {
          setContextMenu(null);
          return;
        }
        setContextMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <header className="topbar">
        <div className="brand">
          <img
            alt=""
            className="brand-icon"
            draggable={false}
            src="/catsvn-icon.png"
          />
          <div>
            <strong>CatSVN</strong>
            <span>{t.appSubtitle}</span>
          </div>
        </div>

        <Segmented
          ariaLabel={t.language}
          className="language-switch"
          onChange={setLocale}
          options={(Object.keys(localeNames) as Locale[]).map((option) => ({
            value: option,
            label: localeNames[option],
          }))}
          value={locale}
        />

        {repo ? (
          <div className="connection-summary">
            <span className="connection-url" title={repo.root_url}>{repo.root_url}</span>
            <span className="revision-chip">r{repo.revision}</span>
            <button className="icon-button" onClick={refreshRepository} title={t.refreshRepository}>
              <RefreshCw size={15} />
            </button>
            <button
              className="icon-button"
              onClick={() => void disconnectRepository()}
              title={t.switchRepository}
            >
              <LogOut size={15} />
            </button>
          </div>
        ) : (
          <span className="topbar-hint">{t.connectHint}</span>
        )}
      </header>

      {!repo ? (
        <main className="connect-layout">
          <form className="connect-panel" onSubmit={connectRepository}>
            <h1>{t.openRepository}</h1>
            <p>{t.intro}</p>

            <label htmlFor="repository-url">{t.repositoryUrl}</label>
            <input
              id="repository-url"
              onBlur={() => void loadSavedCredentials(rootUrl)}
              value={rootUrl}
              onChange={(event) => setRootUrl(event.target.value)}
              placeholder="https://svn.example.com/repo/trunk"
              required
            />

            <label htmlFor="workspace-path">{t.sparseWorkingCopy}</label>
            <input
              id="workspace-path"
              value={workdir}
              onChange={(event) => setWorkdir(event.target.value)}
              placeholder={workdirPlaceholder}
              required
            />

            <div className="credential-grid">
              <div>
                <label htmlFor="svn-username">{t.username}</label>
                <input
                  autoCapitalize="none"
                  autoComplete="username"
                  autoCorrect="off"
                  id="svn-username"
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder={t.optional}
                  spellCheck={false}
                  value={username}
                />
              </div>
              <div>
                <label htmlFor="svn-password">{t.password}</label>
                <input
                  autoCapitalize="none"
                  autoComplete="current-password"
                  autoCorrect="off"
                  id="svn-password"
                  onChange={(event) => setPassword(event.target.value)}
                  spellCheck={false}
                  placeholder={
                    hasSavedPassword && !password ? t.savedLocally : t.optional
                  }
                  type="password"
                  value={password}
                />
              </div>
            </div>

            <label className="remember-password">
              <input
                checked={rememberPassword}
                onChange={(event) => setRememberPassword(event.target.checked)}
                type="checkbox"
              />
              <span>{t.rememberPassword}</span>
            </label>

            <label className="remember-password">
              <input
                checked={autoLogin}
                onChange={(event) => setAutoLogin(event.target.checked)}
                type="checkbox"
              />
              <span>{t.autoConnect}</span>
            </label>

            <button className="primary-button" disabled={loading} type="submit">
              {loading ? <Loader2 className="spin" size={16} /> : <Database size={16} />}
              {t.connect}
            </button>

            {error && <div className="status error">{error}</div>}
          </form>
        </main>
      ) : (
        <main
          className={`workspace${pendingUploads.length > 0 || localChanges.length > 0 ? " has-changes" : ""}${
            resizingSidebar ? " resizing-sidebar" : ""
          }`}
          style={{
            gridTemplateColumns:
              pendingUploads.length > 0 || localChanges.length > 0
                ? `${leftWidth}px 6px minmax(0, 1fr) 6px ${rightWidth}px`
                : `${leftWidth}px 6px minmax(0, 1fr)`,
          }}
        >
            <aside className={`browser-panel${scrolled.list ? " scrolled" : ""}`}>
              <div className="panel-heading">
                <span>{t.repositoryTitle}</span>
                <div className="panel-heading-actions">
                  <button
                    className="icon-button"
                    disabled={loading || navCursor.index === 0}
                    onClick={() => void goBack()}
                    title={t.navigateBack}
                  >
                    <ArrowLeft size={15} />
                  </button>
                  <button
                    className="icon-button"
                    disabled={loading || navCursor.index >= navCursor.length - 1}
                    onClick={() => void goForward()}
                    title={t.navigateForward}
                  >
                    <ArrowRight size={15} />
                  </button>
                  <button
                    className="icon-button"
                    onClick={() => void openHistory("")}
                    title={t.repositoryHistory}
                  >
                    <History size={15} />
                  </button>
                  <button className="icon-button" onClick={() => void reloadDirectory()} title={t.refreshDirectory}>
                    <RefreshCw size={15} />
                  </button>
                </div>
            </div>

            <Segmented<BrowseMode>
              className="view-switch"
              onChange={(mode) => void switchBrowseMode(mode)}
              options={[
                { value: "remote", label: t.remoteDirectory, disabled: loading },
                { value: "local", label: t.localCheckedOut, disabled: loading },
              ]}
              value={browseMode}
            />

            <div className="breadcrumbs">
              <button className="breadcrumb" onClick={() => loadDirectory("")}>{t.root}</button>
              {breadcrumbs.map((part, index) => {
                const target = breadcrumbs.slice(0, index + 1).join("/");
                return (
                  <span key={target} className="breadcrumb-item">
                    <ChevronRight size={13} />
                    <button
                      className="breadcrumb"
                      disabled={index === breadcrumbs.length - 1}
                      onClick={() => void navigateTo(target)}
                    >
                      {part}
                    </button>
                  </span>
                );
              })}
            </div>

            <div className="filter-bar">
              <input
                onChange={(event) => setFilter(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  event.stopPropagation();
                  setFilter("");
                }}
                placeholder={t.filterEntries}
                value={filter}
              />
            </div>

            <div className="upload-bar">
              <button
                className="icon-button"
                disabled={loading}
                onClick={() => void openHistory(path)}
                title={t.folderHistory}
              >
                <History size={15} />
              </button>
              <button className="toolbar-button" disabled={loading} onClick={() => void uploadSelection("file")}>
                <FilePlus size={15} />
                {t.uploadFile}
              </button>
              <button className="toolbar-button" disabled={loading} onClick={() => void uploadSelection("folder")}>
                <FolderPlus size={15} />
                {t.uploadFolder}
              </button>
            </div>

            <div
              className="entry-list"
              onKeyDown={handleEntryListKeyDown}
              onScroll={trackScroll("list")}
              ref={entryListRef}
            >
              {path && (
                <button
                  className="entry-row parent-row"
                  onClick={() => void navigateTo(parentPath(path))}
                >
                  <ChevronUp size={15} />
                  <span>{t.parentDirectory}</span>
                </button>
              )}

              {visibleEntries.map((entry) => (
                <div
                  key={entry.path}
                  className={`entry-row${selected?.path === entry.path ? " selected" : ""}`}
                  data-kind={entry.kind}
                  title={entry.path}
                  onClick={() => {
                    if (entry.kind === "dir") {
                      void navigateTo(entry.path);
                    } else {
                      setSelected(entry);
                    }
                  }}
                  onDoubleClick={() => {
                    if (entry.kind === "file") void previewEntry(entry);
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || event.target !== event.currentTarget) return;
                    if (entry.kind === "dir") {
                      void navigateTo(entry.path);
                    } else {
                      void previewEntry(entry);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <div className="entry-name">
                    {browseMode === "remote" && entry.checked_out && (
                      <span
                        aria-label={t.checkedOutLocally}
                        className="local-dot"
                        role="img"
                        title={t.checkedOutLocally}
                      />
                    )}
                    {entry.kind === "dir" ? <Folder size={16} /> : <FileText size={16} />}
                    <span title={entry.path}>{entry.name}</span>
                  </div>
                  <div className="entry-meta">
                    <span>{entry.kind === "dir" ? t.folder : formatBytes(entry.size)}</span>
                    <span>{entry.revision ? `r${entry.revision}` : "-"}</span>
                  </div>
                  <div className="entry-actions">
                    <button
                      className="icon-button"
                      onClick={(event) => {
                        event.stopPropagation();
                        void openHistory(entry.path);
                      }}
                      title={t.historyFor(entry.name)}
                    >
                      <History size={15} />
                    </button>

                    {/* Slot 2: checkout for folders, preview for files. The empty
                        slot keeps every row's buttons in the same columns. */}
                    {entry.kind === "dir" ? (
                      browseMode === "remote" ? (
                        <button
                          className="icon-button"
                          disabled={loading}
                          onClick={(event) => {
                            event.stopPropagation();
                            openCheckout(entry.path);
                          }}
                          title={t.checkoutFolder}
                        >
                          <Download size={15} />
                        </button>
                      ) : (
                        <span aria-hidden="true" className="action-slot" />
                      )
                    ) : (
                      <button
                        className="icon-button"
                        onClick={(event) => {
                          event.stopPropagation();
                          void previewEntry(entry);
                        }}
                        title={t.previewFromRepository}
                      >
                        <Eye size={15} />
                      </button>
                    )}

                    {/* Slot 3: drop the local checkout for folders, edit for files. */}
                    {entry.kind === "dir" ? (
                      browseMode === "local" || entry.checked_out ? (
                        <button
                          className="icon-button"
                          disabled={loading}
                          onClick={(event) => {
                            event.stopPropagation();
                            setExcludeTarget(entry.path);
                          }}
                          title={t.removeLocalCheckout}
                        >
                          <Trash2 size={15} />
                        </button>
                      ) : (
                        <span aria-hidden="true" className="action-slot" />
                      )
                    ) : (
                      <button
                        className="icon-button"
                        onClick={(event) => {
                          event.stopPropagation();
                          void openEditor(entry);
                        }}
                        title={t.fetchOnlyThisFile}
                      >
                        <Pencil size={15} />
                      </button>
                    )}
                  </div>
                </div>
              ))}

              {!loading && visibleEntries.length === 0 && (
                <div className="empty-state">
                  {filter
                    ? t.noMatches
                    : browseMode === "local"
                      ? t.emptyLocalDirectory
                      : t.emptyDirectory}
                </div>
              )}
            </div>

          </aside>

          <div
            aria-orientation="vertical"
            className={`column-resizer${resizingSidebar?.side === "left" ? " active" : ""}`}
            onDoubleClick={() => resetSidebarWidth("left")}
            onPointerDown={(event) => startSidebarResize(event, "left")}
            onPointerMove={resizeSidebar}
            onPointerUp={stopSidebarResize}
            role="separator"
            title={t.resizeRepository}
          />

          <section className={`file-panel${scrolled.file ? " scrolled" : ""}`}>
            {selected && preview ? (
              <>
                <div className="file-toolbar">
                  <div className="file-title">
                    <FileText size={17} />
                    <div>
                      <strong>{selected.name}</strong>
                      <span>{selected.path}</span>
                    </div>
                  </div>

                  <Segmented<FileTab>
                    className="segmented"
                    onChange={(next) => {
                      if (next === "diff") {
                        void showDiff();
                        return;
                      }
                      setTab(next);
                    }}
                    options={[
                      { value: "preview", label: t.preview, icon: <Eye size={15} /> },
                      { value: "edit", label: t.edit, icon: <Pencil size={15} /> },
                      {
                        value: "diff",
                        label: t.diff,
                        icon: <GitCompare size={15} />,
                      },
                    ]}
                    value={tab}
                  />

                  <div className="file-actions">
                    <button className="toolbar-button" disabled={loading} onClick={refreshFile}>
                      <Download size={15} />
                      {t.update}
                    </button>
                    <button className="toolbar-button" disabled={loading || !dirty} onClick={discardFile}>
                      <Undo2 size={15} />
                      {t.revert}
                    </button>
                    <button
                      className="toolbar-button"
                      disabled={loading || draft == null}
                      onClick={() => void saveCurrentFile()}
                    >
                      <Save size={15} />
                      {t.save}
                    </button>
                    <button
                      className="icon-button"
                      disabled={loading || !selected?.checked_out}
                      onClick={() => void openLocalFile()}
                      title={t.openInDefaultApp}
                    >
                      <ExternalLink size={15} />
                    </button>
                  </div>
                </div>

                <div className="file-body" key={tab}>
                  {tab === "preview" && (
                    <pre className="file-view" onScroll={trackScroll("file")}>
                      {preview.content || t.noTextContent}
                    </pre>
                  )}

                  {tab === "edit" && (
                    <textarea
                      className="file-editor"
                      onChange={(event) => {
                        setDraft(event.target.value);
                        setDirty(true);
                      }}
                      onScroll={trackScroll("file")}
                      spellCheck={false}
                      value={draft ?? ""}
                    />
                  )}

                  {tab === "diff" && (
                    <pre className="file-view diff-view" onScroll={trackScroll("file")}>
                      {diff || t.noLocalChanges}
                    </pre>
                  )}
                </div>

                <div className="commit-bar">
                  <input
                    onChange={(event) => setCommitMessage(event.target.value)}
                    placeholder={t.commitMessage}
                    value={commitMessage}
                  />
                  <button className="primary-button" disabled={loading || !dirty} onClick={commitCurrentFile}>
                    {loading ? <Loader2 className="spin" size={15} /> : <Upload size={15} />}
                    {t.commit}
                  </button>
                </div>
              </>
            ) : (
              <div className="placeholder-panel">
                <FileText size={36} />
                <h2>{t.selectFile}</h2>
                <p>{t.selectFileHelp}</p>
              </div>
            )}

            {(notice || error) && (
              <div className={`status ${error ? "error" : "success"}`}>{error || notice}</div>
            )}
          </section>

          {(pendingUploads.length > 0 || localChanges.length > 0) && (
            <div
              aria-orientation="vertical"
              className={`column-resizer${resizingSidebar?.side === "right" ? " active" : ""}`}
              onDoubleClick={() => resetSidebarWidth("right")}
              onPointerDown={(event) => startSidebarResize(event, "right")}
              onPointerMove={resizeSidebar}
              onPointerUp={stopSidebarResize}
              role="separator"
              title={t.resizeChanges}
            />
          )}

          {(pendingUploads.length > 0 || localChanges.length > 0) && (
            <aside className={`changes-panel${scrolled.changes ? " scrolled" : ""}`}>
              <div className="panel-heading">
                <span>{t.changes}</span>
                <button className="icon-button" onClick={() => void loadLocalChanges()} title={t.refreshLocalChanges}>
                  <RefreshCw size={15} />
                </button>
              </div>

              <div className="changes-scroll" onScroll={trackScroll("changes")}>
                {pendingUploads.length > 0 && (
                  <div className="upload-pending">
                    <div className="upload-pending-heading">
                      <span>{t.pendingUploads}</span>
                      <span className="revision-chip">{pendingUploads.length}</span>
                    </div>
                    {pendingUploads.map((upload) => (
                      <div
                        className="upload-pending-item"
                        key={upload.path}
                        title={upload.path}
                        onMouseEnter={() => setHoveredPath(upload.path)}
                        onMouseLeave={() =>
                          setHoveredPath((current) =>
                            current === upload.path ? null : current,
                          )
                        }
                      >
                        {upload.kind === "dir" ? <Folder size={15} /> : <FileText size={15} />}
                        <span className="change-path" title={upload.path}>{upload.path}</span>
                        <button
                          className="item-delete-button"
                          disabled={loading || deletingPath === `added:${upload.path}`}
                          onClick={() => void discardChange(upload.path, "added")}
                          title={t.discard(upload.path)}
                        >
                          {deletingPath === `added:${upload.path}` ? (
                            <Loader2 className="spin" size={14} />
                          ) : (
                            <Trash2 size={14} />
                          )}
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {localChanges.length > 0 && (
                  <div className="upload-pending local-changes">
                    <div className="upload-pending-heading">
                      <span>{t.localUncommittedChanges}</span>
                      <span className="revision-chip">{localChanges.length}</span>
                    </div>
                    {localChanges.map((change) => (
                      <div
                        className="upload-pending-item"
                        key={`${change.status}:${change.path}`}
                        title={change.path}
                        onMouseEnter={() => setHoveredPath(change.path)}
                        onMouseLeave={() =>
                          setHoveredPath((current) =>
                            current === change.path ? null : current,
                          )
                        }
                      >
                        {change.kind === "dir" ? <Folder size={15} /> : <FileText size={15} />}
                        <span className="change-path" title={change.path}>{change.path}</span>
                        <span className={`status-chip status-${change.status}`}>{change.status}</span>
                        <button
                          className="item-delete-button"
                          disabled={
                            loading ||
                            deletingPath ===
                              `${change.status}:${change.path}`
                          }
                          onClick={() =>
                            void discardChange(change.path, change.status)
                          }
                          title={t.discard(change.path)}
                        >
                          {deletingPath ===
                          `${change.status}:${change.path}` ? (
                            <Loader2 className="spin" size={14} />
                          ) : (
                            <Trash2 size={14} />
                          )}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                  </div>

                  {hoveredPath && (
                    <div className="path-preview">
                      <span className="path-preview-label">{t.fullPath}</span>
                      <span className="path-preview-value">{hoveredPath}</span>
                    </div>
                  )}

              {pendingUploads.length > 0 && (
                <div className="upload-commit-bar">
                  <input
                    onChange={(event) => setUploadCommitMessage(event.target.value)}
                    placeholder={t.commitMessageForUploads}
                    value={uploadCommitMessage}
                  />
                  <button
                    className="primary-button"
                    disabled={loading || !uploadCommitMessage.trim()}
                    onClick={() => void commitPendingUploads()}
                  >
                    {loading ? <Loader2 className="spin" size={15} /> : <Upload size={15} />}
                    {t.commit}
                  </button>
                </div>
              )}
            </aside>
          )}
        </main>
      )}

      {checkoutOpen && (
        <div className="modal-backdrop">
          <div className="checkout-modal">
            <div className="history-toolbar">
              <div className="history-title">
                <Download size={18} />
                <div>
                  <strong>{t.checkoutFolder}</strong>
                  <span>{checkoutTarget || t.root}</span>
                </div>
              </div>
              <button
                className="icon-button"
                disabled={checkoutLoading}
                onClick={() => setCheckoutOpen(false)}
                title={t.closeHistory}
              >
                <X size={16} />
              </button>
            </div>

            <div className="checkout-body">
              <label className="checkout-option">
                <input
                  checked={checkoutMode === "files"}
                  disabled={checkoutLoading}
                  name="checkout-mode"
                  onChange={() => setCheckoutMode("files")}
                  type="radio"
                />
                <span>{t.checkoutFiles}</span>
              </label>
              <label className="checkout-option">
                <input
                  checked={checkoutMode === "subfolders"}
                  disabled={checkoutLoading}
                  name="checkout-mode"
                  onChange={() => setCheckoutMode("subfolders")}
                  type="radio"
                />
                <span>{t.checkoutSubfolders}</span>
              </label>
              <label className="checkout-option">
                <input
                  checked={checkoutMode === "all"}
                  disabled={checkoutLoading}
                  name="checkout-mode"
                  onChange={() => setCheckoutMode("all")}
                  type="radio"
                />
                <span>{t.checkoutAll}</span>
              </label>
              <label className="checkout-option">
                <input
                  checked={checkoutMode === "custom"}
                  disabled={checkoutLoading}
                  name="checkout-mode"
                  onChange={() => setCheckoutMode("custom")}
                  type="radio"
                />
                <span>{t.checkoutCustom}</span>
              </label>

              {checkoutMode === "custom" && (
                <div className="custom-depth">
                  <label htmlFor="checkout-levels">{t.checkoutLevels}</label>
                  <input
                    id="checkout-levels"
                    max={8}
                    min={1}
                    onChange={(event) => {
                      const value = Number(event.target.value);
                      setCheckoutLevels(Number.isFinite(value) ? Math.max(1, Math.min(8, value)) : 1);
                    }}
                    type="number"
                    value={checkoutLevels}
                  />
                </div>
              )}
            </div>

            <div className="checkout-actions">
              <button
                className="toolbar-button"
                disabled={checkoutLoading}
                onClick={() => setCheckoutOpen(false)}
              >
                {t.closeHistory}
              </button>
              <button
                className="primary-button"
                disabled={checkoutLoading}
                onClick={() => void checkoutDirectory()}
              >
                {checkoutLoading ? <Loader2 className="spin" size={15} /> : <Download size={15} />}
                {t.checkoutStart}
              </button>
            </div>
          </div>
        </div>
      )}

      {excludeTarget && (
        <div className="modal-backdrop">
          <div className="checkout-modal">
            <div className="history-toolbar">
              <div className="history-title">
                <Trash2 size={18} />
                <div>
                  <strong>{t.removeLocalCheckout}</strong>
                  <span>{excludeTarget}</span>
                </div>
              </div>
              <button
                className="icon-button"
                disabled={loading}
                onClick={() => setExcludeTarget("")}
                title={t.cancel}
              >
                <X size={16} />
              </button>
            </div>

            <div className="checkout-body">
              <p className="exclude-note">{t.removeLocalCheckoutHelp}</p>
            </div>

            <div className="checkout-actions">
              <button
                className="toolbar-button"
                disabled={loading}
                onClick={() => setExcludeTarget("")}
              >
                {t.cancel}
              </button>
              <button
                className="primary-button"
                disabled={loading}
                onClick={() => void confirmExcludeCheckout()}
              >
                {loading ? <Loader2 className="spin" size={15} /> : <Trash2 size={15} />}
                {t.removeLocalCheckoutConfirm}
              </button>
            </div>
          </div>
        </div>
      )}

      {historyOpen && (
        <div className="modal-backdrop">
          <div className="history-modal">
            <div className="history-toolbar">
              <div className="history-title">
                <History size={18} />
                <div>
                  <strong>
                    {historyTarget ? sourceName(historyTarget) : t.repositoryTitle}
                  </strong>
                  <span>{historyTarget || repo?.root_url}</span>
                </div>
              </div>
              <div className="history-toolbar-actions">
                <button
                  className="icon-button"
                  disabled={historyLoading}
                  onClick={() => void refreshHistory()}
                  title={t.refreshHistory}
                >
                  <RefreshCw size={15} />
                </button>
                <button
                  className="icon-button"
                  onClick={() => setHistoryOpen(false)}
                  title={t.closeHistory}
                >
                  <X size={16} />
                </button>
              </div>
            </div>

            <div className="history-layout">
              <div className="history-list">
                {historyLoading && (
                  <div className="history-empty">
                    <Loader2 className="spin" size={20} />
                    <span>{t.loadingHistory}</span>
                  </div>
                )}

                {!historyLoading && historyError && (
                  <div className="status error">{historyError}</div>
                )}

                {!historyLoading && !historyError && historyEntries.length === 0 && (
                  <div className="history-empty">{t.noHistory}</div>
                )}

                {!historyLoading &&
                  historyEntries.map((entry) => (
                    <article
                      key={entry.revision}
                      className={`history-entry${
                        selectedHistoryRevision === entry.revision ? " selected" : ""
                      }`}
                    >
                      <div className="history-entry-header">
                        <span className="revision-chip">r{entry.revision}</span>
                        <span>{entry.author || t.unknown}</span>
                        <span>{formatDate(entry.date)}</span>
                      </div>
                      {entry.message && (
                        <p className="history-message">{entry.message}</p>
                      )}

                      {entry.changed_paths.length > 0 && (
                        <div className="history-paths">
                          {entry.changed_paths.map((changedPath) => (
                            <div
                              className="history-path"
                              key={`${entry.revision}:${changedPath.action}:${changedPath.path}`}
                              title={changedPath.path}
                            >
                              <span className="history-action">
                                {changedPath.action}
                              </span>
                              <span>{changedPath.path}</span>
                            </div>
                          ))}
                        </div>
                      )}

                      <button
                        className="toolbar-button"
                        disabled={historyDiffLoading}
                        onClick={() => void diffHistoryRevision(entry.revision)}
                      >
                        <GitCompare size={15} />
                        {t.diffWithHead(entry.revision)}
                      </button>
                    </article>
                  ))}
              </div>

              <div className="history-detail">
                <div className="history-detail-header">
                  {selectedHistoryRevision ? (
                    <span>r{selectedHistoryRevision} → HEAD</span>
                  ) : (
                    <span>{t.selectCommit}</span>
                  )}
                  {historyDiff && (
                    <span className="revision-chip">
                      {formatBytes(historyDiff.byte_size)}
                    </span>
                  )}
                </div>

                {historyDiffLoading && (
                  <div className="history-empty">
                    <Loader2 className="spin" size={20} />
                    <span>{t.generatingDiff}</span>
                  </div>
                )}

                {!historyDiffLoading && historyDiffError && (
                  <div className="status error">{historyDiffError}</div>
                )}

                {!historyDiffLoading && !historyDiffError && historyDiff && (
                  <>
                    {historyDiff.truncated && (
                      <div className="status error">
                        {t.diffTruncated(formatBytes(historyDiff.byte_size))}
                      </div>
                    )}
                    <pre className="history-diff">{historyDiff.output}</pre>
                  </>
                )}

                {!historyDiffLoading &&
                  !historyDiffError &&
                  !historyDiff &&
                  !selectedHistoryRevision && (
                    <div className="history-empty">
                      {t.chooseCommit}
                    </div>
                  )}
              </div>
            </div>
          </div>
        </div>
      )}

      {repo && dragActive && (
        <div className="drop-overlay">
          <Upload size={28} />
          <strong>{t.dropToUpload}</strong>
          <span>{t.dropHelp(path)}</span>
        </div>
      )}

      {loading && (
        <div aria-live="polite" className="loading-overlay" role="status">
          <div className="loading-chip">
            <Loader2 className="spin" size={26} />
          </div>
          <span>{t.loading}</span>
        </div>
      )}

      {contextMenu && repo && (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            onClick={() => {
              setContextMenu(null);
              void reloadDirectory();
            }}
            type="button"
          >
            <RefreshCw size={14} />
            {t.refreshDirectory}
          </button>
        </div>
      )}
    </div>
  );
}
