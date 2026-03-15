import { createResource, For, Show, createSignal, createMemo, createEffect, onMount, onCleanup } from "solid-js";
import { isServer } from "solid-js/web";
import { fetchEmailsPaginated, fetchThreadsPaginated, deleteEmail, deleteEmailsBatch, archiveEmails, addEmailLabel, removeEmailLabel, toggleStar, markAsRead, markAsUnread, moveToFolder, snoozeEmails, getBlockedSenders, blockSender, getEmail } from "~/lib/mail-client";
import { useNavigate, useLocation } from "@solidjs/router";
import { settings } from "~/lib/settings-store";
import { refreshCounts } from "~/lib/sidebar-store";
import {
  labelsState,
  setActiveFilter,
  addLabel,
  LABEL_COLORS,
  IMPORTANT_FILTER_ID,
  IMPORTANT_LABEL_NAME,
  getVisibleLabels,
  getConfiguredCategories,
  getCategoryTabs,
  normalizeCategoryNameToKey,
  isCategoryFilterId,
  categoryKeyFromFilterId,
  matchesCategoryFlags,
  PRIMARY_CATEGORY_KEY,
  isConfiguredCategoryKey,
  getCategoryNameFromLabel,
  type CategoryIconId,
} from "~/lib/labels-store";
import { autoLabelRulesState } from "~/lib/auto-label-rules-store";
import { buildPaginationNamespace, getCachedPage, setCachedPage } from "~/lib/pagination-cache";
import VirtualEmailList from "~/components/VirtualEmailList";
import ReadingPane from "~/components/ReadingPane";
import ContextMenu, { type ContextMenuItem } from "~/components/ContextMenu";
import SnoozeMenu from "~/components/SnoozeMenu";
import KeyboardShortcutsHelp from "~/components/KeyboardShortcutsHelp";
import { IconMail, IconRefresh, IconArchive, IconTrash, IconChevronLeft, IconChevronRight, IconClose, IconStar, IconEnvelope, IconEnvelopeOpen, IconReply, IconFolder, IconSpam, IconExpand, IconCollapse, IconLabel, IconInbox, IconUsers, IconInfo, IconSparkles, IconBriefcase, IconCart, IconReceipt, IconHeart, IconCode, IconBolt, IconClock, IconBlock, IconCheck } from "~/components/Icons";
import { useMailEvents } from "~/lib/mail-events";
import { showToast } from "~/lib/toast-store";
import { cacheBlockedSenderEmails } from "~/lib/blocked-senders-cache";
import { openCompose, composeState, closeCompose, toggleMinimize, toggleFullscreen, saveComposeDraftNow } from "~/lib/compose-store";
import { SHORTCUT_ACTIONS, getEffectiveActionShortcuts, splitShortcutSteps, formatShortcut, getActionShortcutHint, type ShortcutActionId } from "~/lib/keyboard-shortcuts-store";
import { formatForwardSubject, formatReplySubject, getForwardQuoteParts, getReplyAllRecipients, getReplyQuoteParts, getReplyRecipients } from "~/lib/reply-utils";

export default function Home() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchTerm, setSearchTerm] = createSignal("");
  const [selectedEmail, setSelectedEmail] = createSignal<number | null>(null);
  const [selectedThreadId, setSelectedThreadId] = createSignal<string | null>(null);
  const [selectedEmails, setSelectedEmails] = createSignal<Set<number>>(new Set());
  const [paneSize, setPaneSize] = createSignal(600);
  const [isResizing, setIsResizing] = createSignal(false);
  const [currentPage, setCurrentPage] = createSignal(1);
  const [pendingPage, setPendingPage] = createSignal<number | null>(null);
  const [networkLoadingPage, setNetworkLoadingPage] = createSignal<number | null>(null);
  const [currentCursor, setCurrentCursor] = createSignal<string | null>(null);
  const [pageCursors, setPageCursors] = createSignal<Map<string, string | null>>(new Map());
  const [pageCache, setPageCache] = createSignal<Map<string, Awaited<ReturnType<typeof fetchEmailsPaginated>>>>(new Map());
  const [lastPageNavAt, setLastPageNavAt] = createSignal(0);
  const [fullSpacePane, setFullSpacePane] = createSignal(false);
  const [newConversationKeys, setNewConversationKeys] = createSignal<Set<string>>(new Set());
  const [isImportActive, setIsImportActive] = createSignal(false);
  const [refreshIndicatorState, setRefreshIndicatorState] = createSignal<"idle" | "refreshing" | "success">("idle");
  const attemptedAutoLabelKeys = new Set<string>();
  let autoLabelQueue: Promise<void> = Promise.resolve();

  let refreshInFlight = false;
  let refreshQueued = false;
  let refreshQueueTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshIndicatorTimer: ReturnType<typeof setTimeout> | undefined;
  let lastRefreshAt = 0;
  const MIN_REFRESH_GAP_MS = 1500;
  const prefetchInFlight = new Set<number>();
  const blockedMovesInFlight = new Set<number>();

  // Context menu state
  const [contextMenu, setContextMenu] = createSignal<{ x: number; y: number; seq: number; flags: string[] } | null>(null);
  const [snoozeMenuPosition, setSnoozeMenuPosition] = createSignal<{ x: number; y: number } | null>(null);
  const [pendingSnoozeTargets, setPendingSnoozeTargets] = createSignal<Array<{ seq: number; folder: string }>>([]);
  const [draggedEmailSeqs, setDraggedEmailSeqs] = createSignal<number[]>([]);
  const [dragOverCategoryKey, setDragOverCategoryKey] = createSignal<string | null>(null);
  const [pointerDragActive, setPointerDragActive] = createSignal(false);
  let dragPreviewEl: HTMLDivElement | null = null;
  let categoryDropInProgress = false;
  let lastCategoryDropAt = 0;

  // Pointer-based custom DnD state
  const DRAG_THRESHOLD_PX = 5;
  let pointerDragOrigin: { x: number; y: number; seq: number } | null = null;
  let pointerDragStarted = false;
  let categoryTabRects: Array<{ key: string; rect: DOMRect }> = [];
  let pointerDragCleanup: (() => void) | null = null;

  const perPage = () => parseInt(settings.emailsPerPage) || 50;
  const configuredCategories = createMemo(() => getConfiguredCategories());
  const categoryTabs = createMemo(() => getCategoryTabs());
  const shouldShowCategoryTabs = createMemo(() => {
    const filter = labelsState.activeFilter;
    if (!settings.enableCategories) return false;
    return !filter || isCategoryFilterId(filter);
  });
  const activeCategoryKey = createMemo(() => {
    if (!settings.enableCategories) return null;
    const filter = labelsState.activeFilter;
    if (!filter) return PRIMARY_CATEGORY_KEY;
    if (isCategoryFilterId(filter)) return categoryKeyFromFilterId(filter) || PRIMARY_CATEGORY_KEY;
    return null;
  });
  const categoryIconById = (icon: CategoryIconId) => {
    if (icon === "inbox") return IconInbox;
    if (icon === "tag") return IconLabel;
    if (icon === "users") return IconUsers;
    if (icon === "info") return IconInfo;
    if (icon === "sparkles") return IconSparkles;
    if (icon === "briefcase") return IconBriefcase;
    if (icon === "cart") return IconCart;
    if (icon === "receipt") return IconReceipt;
    if (icon === "heart") return IconHeart;
    if (icon === "code") return IconCode;
    if (icon === "bolt") return IconBolt;
    return IconSparkles;
  };
  const primaryMailbox = createMemo(() => {
    const categoryFlags = configuredCategories()
      .map((category) => `Category ${category.name}`.trim())
      .filter(Boolean);
    if (categoryFlags.length === 0) return "inbox:primary";
    return `inbox:primary:${categoryFlags.join("|")}`;
  });
  const activeMailbox = createMemo(() => {
    const filter = labelsState.activeFilter;
    if (filter === "starred") return "Starred";
    if (filter === IMPORTANT_FILTER_ID) return "Important";
    if (settings.enableCategories && filter && isCategoryFilterId(filter)) {
      const categoryKey = categoryKeyFromFilterId(filter);
      if (!categoryKey || categoryKey === PRIMARY_CATEGORY_KEY) return primaryMailbox();
      const tab = categoryTabs().find((item) => item.key === categoryKey);
      if (!tab) return primaryMailbox();
      return `label:Category ${tab.name}`;
    }
    if (settings.enableCategories && !filter) {
      return primaryMailbox();
    }
    if (filter) {
      const label = getVisibleLabels().find((l) => l.id === filter);
      if (label?.name) return `label:${label.name}`;
    }
    return "INBOX";
  });
  const effectiveThreaded = createMemo(() => settings.conversationView && activeMailbox() === "INBOX");
  const folderForSeq = (seq: number) => {
    const email = paginatedData()?.emails.find((e) => e.seq === seq);
    return email?.folderPath || "INBOX";
  };
  const cacheNamespace = createMemo(() =>
    buildPaginationNamespace({
      folder: activeMailbox(),
      threaded: effectiveThreaded(),
      perPage: perPage(),
    })
  );
  const getPageCacheKey = (namespace: string, page: number) => `${namespace}::${page}`;
  const pageCacheKey = (page: number) => getPageCacheKey(cacheNamespace(), page);

  const storePageData = (
    page: number,
    data: Awaited<ReturnType<typeof fetchEmailsPaginated>>,
    threaded: boolean,
    namespace = cacheNamespace(),
  ) => {
    setPageCache((prev) => {
      const next = new Map(prev);
      next.set(getPageCacheKey(namespace, page), data);
      return next;
    });
    if (!threaded) {
      setPageCursors((prev) => {
        const next = new Map(prev);
        const nextPageKey = getPageCacheKey(namespace, page + 1);
        if (data.nextCursor) next.set(nextPageKey, data.nextCursor);
        else next.delete(nextPageKey);
        return next;
      });
    }
    void setCachedPage(namespace, page, data).catch(() => {});
  };

  const [showKeyboardHelp, setShowKeyboardHelp] = createSignal(false);

  onMount(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("paneSize");
      if (saved) setPaneSize(parseInt(saved));
      const updateImportActive = () => {
        setIsImportActive(localStorage.getItem("takeoutImportActive") === "true");
      };
      updateImportActive();
      const importStatePoll = setInterval(updateImportActive, 2000);
      onCleanup(() => clearInterval(importStatePoll));
    }
  });

  onMount(() => {
    if (typeof window === "undefined") return;

    let pendingChordStep: string | null = null;
    let chordTimer: ReturnType<typeof setTimeout> | undefined;
    const SHIFTED_SYMBOL_ALIASES: Record<string, string> = {
      "/": "?",
      "1": "!",
      "3": "#",
    };
    const REVERSE_SHIFTED_ALIASES: Record<string, string> = {
      "?": "/",
      "!": "1",
      "#": "3",
    };

    const isInInput = (el: EventTarget | null): boolean => {
      if (!el || !(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      if (el.isContentEditable) return true;
      return false;
    };

    const addCandidate = (set: Set<string>, key: string, mods: { ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }) => {
      if (!key) return;
      const prefix = ["ctrl", "alt", "shift", "meta"].filter((mod) => mods[mod as keyof typeof mods]).join("+");
      set.add(prefix ? `${prefix}+${key}` : key);
    };

    const eventStepCandidates = (e: KeyboardEvent): Set<string> => {
      const candidates = new Set<string>();
      const mods = { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey };

      let key = e.key;
      if (key === "Esc") key = "Escape";
      if (key === " ") key = "Space";
      if (key.startsWith("Arrow")) key = key.slice(5);
      key = key.toLowerCase();

      const isLetter = key.length === 1 && /[a-z]/.test(key);
      if (isLetter && e.shiftKey) {
        addCandidate(candidates, key, mods);
        return candidates;
      }

      if (e.shiftKey) {
        addCandidate(candidates, key, mods);
        const alias = SHIFTED_SYMBOL_ALIASES[key] || key;
        addCandidate(candidates, alias, { ...mods, shift: false });
        if (REVERSE_SHIFTED_ALIASES[key]) {
          addCandidate(candidates, key, { ...mods, shift: false });
        }
        return candidates;
      }

      addCandidate(candidates, key, mods);
      return candidates;
    };

    const shortcutsFor = (actionId: ShortcutActionId): string[][] =>
      getEffectiveActionShortcuts(actionId)
        .map((shortcut) => splitShortcutSteps(shortcut))
        .filter((steps) => steps.length > 0);

    const actionLabelById = (actionId: ShortcutActionId) =>
      SHORTCUT_ACTIONS.find((action) => action.id === actionId)?.label || actionId;

    const showShortcutFeedback = (shortcut: string, actionId: ShortcutActionId) => {
      if (!settings.shortcutFeedback) return;
      showToast(`${formatShortcut(shortcut)} -> ${actionLabelById(actionId)}`, "info");
    };

    const matchSingleStepAction = (candidates: Set<string>): { actionId: ShortcutActionId; shortcut: string } | null => {
      for (const action of SHORTCUT_ACTIONS) {
        for (const steps of shortcutsFor(action.id)) {
          if (steps.length === 1 && candidates.has(steps[0])) {
            return { actionId: action.id, shortcut: steps[0] };
          }
        }
      }
      return null;
    };

    const matchChordAction = (firstStep: string, candidates: Set<string>): { actionId: ShortcutActionId; shortcut: string } | null => {
      for (const action of SHORTCUT_ACTIONS) {
        for (const steps of shortcutsFor(action.id)) {
          if (steps.length === 2 && steps[0] === firstStep && candidates.has(steps[1])) {
            return { actionId: action.id, shortcut: `${steps[0]} ${steps[1]}` };
          }
        }
      }
      return null;
    };

    const matchChordStart = (candidates: Set<string>): string | null => {
      for (const action of SHORTCUT_ACTIONS) {
        const match = shortcutsFor(action.id).find((steps) => steps.length === 2 && candidates.has(steps[0]));
        if (match) return match[0];
      }
      return null;
    };

    const executeAction = (actionId: ShortcutActionId, e?: Pick<KeyboardEvent, "preventDefault">): boolean => {
      if (actionId === "toggleHelp") {
        setShowKeyboardHelp((v) => !v);
        return true;
      }
      if (actionId === "focusSearch") {
        e?.preventDefault?.();
        const searchInput = document.querySelector<HTMLInputElement>('input[placeholder="Search messages"]');
        searchInput?.focus();
        return true;
      }
      if (actionId === "clearSelection") {
        if (selectedEmail() !== null) {
          setSelectedEmail(null);
          setSelectedThreadId(null);
        }
        if (selectedEmails().size > 0) setSelectedEmails(new Set());
        return true;
      }
      if (actionId === "compose") {
        openCompose();
        return true;
      }
      if (actionId === "sendCompose") {
        if (!composeState().isOpen || composeState().minimized) return false;
        e?.preventDefault?.();
        const form = document.querySelector<HTMLFormElement>(".compose-panel-enter form");
        if (form) form.requestSubmit();
        return true;
      }
      if (actionId === "composeMinimize") {
        if (!composeState().isOpen) return false;
        toggleMinimize();
        return true;
      }
      if (actionId === "composeToggleFullscreen") {
        if (!composeState().isOpen) return false;
        toggleFullscreen();
        return true;
      }
      if (actionId === "composeClose") {
        if (!composeState().isOpen) return false;
        closeCompose();
        return true;
      }
      if (actionId === "composeSaveDraft") {
        if (!composeState().isOpen || composeState().minimized) return false;
        e?.preventDefault?.();
        void saveComposeDraftNow().then(() => {
          showToast("Draft saved", "success");
        }).catch(() => {
          showToast("Could not save draft", "error");
        });
        return true;
      }
      if (actionId === "composeToggleSchedule") {
        if (!composeState().isOpen || composeState().minimized) return false;
        e?.preventDefault?.();
        document.querySelector<HTMLButtonElement>('[data-testid="compose-toggle-schedule"]')?.click();
        return true;
      }
      if (actionId === "composeAttachFiles") {
        if (!composeState().isOpen || composeState().minimized) return false;
        e?.preventDefault?.();
        document.querySelector<HTMLButtonElement>('[data-testid="compose-attach-files"]')?.click();
        return true;
      }
      if (actionId === "refreshEmails") {
        void requestInboxRefresh(true);
        return true;
      }
      if (actionId === "previousPage") {
        if (currentPage() <= 1 || isPageTransitionLoading()) return false;
        goToPage(currentPage() - 1);
        return true;
      }
      if (actionId === "nextPage") {
        if (!canGoNextPage() || isPageTransitionLoading()) return false;
        goToPage(currentPage() + 1);
        return true;
      }
      if (actionId === "reply") {
        const seq = selectedEmail();
        if (seq === null) return false;
        void openComposeForSelection("reply");
        return true;
      }
      if (actionId === "replyAll") {
        const seq = selectedEmail();
        if (seq === null) return false;
        void openComposeForSelection("reply-all");
        return true;
      }
      if (actionId === "forward") {
        const seq = selectedEmail();
        if (seq === null) return false;
        void openComposeForSelection("forward");
        return true;
      }
      if (actionId === "nextConversation") {
        if (selectedEmail() === null && filteredEmails().length > 0) {
          handleEmailClick(filteredEmails()[0].seq);
        } else {
          goToNext();
        }
        return true;
      }
      if (actionId === "previousConversation") {
        goToPrevious();
        return true;
      }
      if (actionId === "openConversation") {
        if (selectedEmail() === null) return false;
        const folder = folderForSeq(selectedEmail()!);
        navigate(`/email/${selectedEmail()}?folder=${encodeURIComponent(folder)}`);
        return true;
      }
      if (actionId === "returnToList") {
        setSelectedEmail(null);
        setSelectedThreadId(null);
        return true;
      }
      if (actionId === "markUnread") {
        void handleBatchMarkRead(false);
        return true;
      }
      if (actionId === "markImportant") {
        const seq = selectedEmail();
        if (seq === null) return false;
        const email = filteredEmails().find((em) => em.seq === seq);
        const isImportant = email?.flags?.includes(IMPORTANT_LABEL_NAME) ?? false;
        void handleImportantToggle(seq, !isImportant);
        return true;
      }
      if (actionId === "archiveConversation") {
        void handleBatchArchive();
        return true;
      }
      if (actionId === "deleteConversation") {
        void handleBatchDelete();
        return true;
      }
      if (actionId === "toggleStar") {
        const seq = selectedEmail();
        if (seq === null) return false;
        const email = filteredEmails().find((em) => em.seq === seq);
        const isStarred = email?.flags?.includes("\\Flagged") ?? false;
        void handleStar(seq, !isStarred);
        return true;
      }
      if (actionId === "toggleSelection") {
        const seq = selectedEmail();
        if (seq === null) return false;
        const isChecked = selectedEmails().has(seq);
        handleCheckedChange(seq, !isChecked);
        return true;
      }
      if (actionId === "reportSpam") {
        void handleBatchMoveToSpam();
        return true;
      }
      if (actionId === "archivePrevious") {
        const seq = selectedEmail();
        if (seq === null) return false;
        void handleArchiveFromList(seq);
        goToPrevious();
        return true;
      }
      if (actionId === "archiveNext") {
        const seq = selectedEmail();
        if (seq === null) return false;
        void handleArchiveFromList(seq);
        goToNext();
        return true;
      }
      if (actionId === "openActionsMenu") {
        return openActionsMenuForSelection();
      }
      if (actionId === "openSnoozeMenu") {
        return openSnoozeMenuForSelection();
      }
      if (actionId === "gotoInbox") {
        navigate("/");
        return true;
      }
      if (actionId === "gotoStarred") {
        navigate("/?filter=starred");
        return true;
      }
      if (actionId === "gotoDrafts") {
        navigate("/folder/Drafts");
        return true;
      }
      if (actionId === "gotoSent") {
        navigate("/folder/Sent");
        return true;
      }
      return false;
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;

      // Always allow Escape to close the help modal
      if (e.key === "Escape" && showKeyboardHelp()) {
        setShowKeyboardHelp(false);
        return;
      }

      const candidates = eventStepCandidates(e);

      // Don't fire shortcuts when user is typing in any input/editor
      if (isInInput(e.target)) {
        const inInputComposeActions: ShortcutActionId[] = [
          "sendCompose",
          "composeMinimize",
          "composeToggleFullscreen",
          "composeClose",
          "composeSaveDraft",
          "composeToggleSchedule",
          "composeAttachFiles",
        ];
        for (const actionId of inInputComposeActions) {
          const match = shortcutsFor(actionId).some((steps) => steps.length === 1 && candidates.has(steps[0]));
          if (match) {
            executeAction(actionId, e);
            return;
          }
        }
        return;
      }

      // Contextual arrow behavior:
      // - If side menus are handling arrows, app-level handler prevents default.
      // - Otherwise arrows navigate the email list.
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (selectedEmail() === null && filteredEmails().length > 0) handleEmailClick(filteredEmails()[0].seq);
        else goToNext();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        if (selectedEmail() === null && filteredEmails().length > 0) handleEmailClick(filteredEmails()[0].seq);
        else goToPrevious();
        return;
      }

      if (pendingChordStep) {
        if (chordTimer !== undefined) clearTimeout(chordTimer);
        const matchedChordAction = matchChordAction(pendingChordStep, candidates);
        pendingChordStep = null;
        if (matchedChordAction && executeAction(matchedChordAction.actionId, e)) {
          showShortcutFeedback(matchedChordAction.shortcut, matchedChordAction.actionId);
          return;
        }
      }

      const singleAction = matchSingleStepAction(candidates);
      if (singleAction && executeAction(singleAction.actionId, e)) {
        showShortcutFeedback(singleAction.shortcut, singleAction.actionId);
        return;
      }

      const chordStart = matchChordStart(candidates);
      if (chordStart) {
        pendingChordStep = chordStart;
        chordTimer = setTimeout(() => { pendingChordStep = null; }, 800);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    const handleSearchExitFocus = () => {
      const first = filteredEmails()[0];
      if (first) handleEmailClick(first.seq);
    };
    window.addEventListener("webmail-search-exit-focus-results", handleSearchExitFocus);
    const handleCommandPaletteAction = (e: Event) => {
      const actionId = (e as CustomEvent<{ actionId?: ShortcutActionId }>).detail?.actionId;
      if (!actionId) return;
      executeAction(actionId);
    };
    document.addEventListener("command-palette-action", handleCommandPaletteAction);
    onCleanup(() => {
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("webmail-search-exit-focus-results", handleSearchExitFocus);
      document.removeEventListener("command-palette-action", handleCommandPaletteAction);
      if (chordTimer !== undefined) clearTimeout(chordTimer);
    });
  });

  const [paginatedData, { mutate }] = createResource(
    () => ({
      page: currentPage(),
      pp: perPage(),
      threaded: effectiveThreaded(),
      cursor: currentCursor(),
      folder: activeMailbox(),
      namespace: cacheNamespace(),
    }),
    async ({ page, pp, threaded, cursor, folder, namespace }, info) => {
      const forceNetwork = Boolean((info as { refetching?: unknown })?.refetching);
      const key = getPageCacheKey(namespace, page);
      if (!forceNetwork) {
        const cached = pageCache().get(key);
        if (cached) return cached;
        let cachedDisk: Awaited<ReturnType<typeof fetchEmailsPaginated>> | null = null;
        try {
          cachedDisk = await getCachedPage(namespace, page) as Awaited<ReturnType<typeof fetchEmailsPaginated>> | null;
        } catch {
          cachedDisk = null;
        }
        if (cachedDisk) {
          storePageData(page, cachedDisk, threaded, namespace);
          return cachedDisk;
        }
      }
      setNetworkLoadingPage(page);
      try {
        const data = threaded
          ? await fetchThreadsPaginated(folder, page, pp)
          : await fetchEmailsPaginated(folder, page, pp, cursor);
        storePageData(page, data, threaded, namespace);
        return data;
      } finally {
        setNetworkLoadingPage(null);
      }
    }
  );

  const [blockedSenders, { refetch: refetchBlocked }] = createResource(getBlockedSenders);
  const isBlocked = (email: string | undefined): boolean => {
    if (!email) return false;
    const lower = email.toLowerCase();
    return (blockedSenders() ?? []).some((b) => b.senderEmail.toLowerCase() === lower);
  };
  createEffect(() => {
    cacheBlockedSenderEmails((blockedSenders() ?? []).map((sender) => sender.senderEmail));
  });

  // Silent refresh: fetches new data and merges it via mutate() — no loading flicker
  const silentRefresh = async () => {
    try {
      const page = currentPage();
      const pp = perPage();
      const threaded = effectiveThreaded();
      const folder = activeMailbox();
      const namespace = cacheNamespace();
      const data = threaded
        ? await fetchThreadsPaginated(folder, page, pp)
        : await fetchEmailsPaginated(folder, page, pp, currentCursor());
      storePageData(page, data, threaded, namespace);
      mutate(data);
      return data;
    } catch {
      // Silently ignore — next poll or SSE will retry
      return null;
    }
  };

  const conversationKey = (email: { seq: number; threadId?: string }) =>
    email.threadId ? `t:${email.threadId}` : `u:${email.seq}`;

  const clearNewBadgeForSeq = (seq: number) => {
    const email = (paginatedData()?.emails || []).find((e) => e.seq === seq);
    if (!email) return;
    const key = conversationKey(email);
    setNewConversationKeys((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  };

  const normalizeDestinationAddress = (input: string) => input.trim().toLowerCase();

  const getDestinationAddresses = (email: EmailMessage) => {
    const all = [...(email.deliveredTo || []), ...(email.to || []), ...(email.cc || [])]
      .map(normalizeDestinationAddress)
      .filter((v) => v.includes("@"));
    return Array.from(new Set(all));
  };

  const getDestinationValues = (
    email: EmailMessage,
    targetField: "destinationAddress" | "destinationLocalPart" | "destinationPlusTag",
  ) => {
    const addresses = getDestinationAddresses(email);
    if (targetField === "destinationAddress") return addresses;

    if (targetField === "destinationLocalPart") {
      const values = addresses.map((addr) => addr.split("@")[0] || "").filter(Boolean);
      return Array.from(new Set(values));
    }

    const plusTags = addresses
      .map((addr) => {
        const local = addr.split("@")[0] || "";
        const plusIdx = local.indexOf("+");
        return plusIdx >= 0 ? local.slice(plusIdx + 1).trim() : "";
      })
      .filter(Boolean);
    return Array.from(new Set(plusTags));
  };

  const matchDestinationRule = (
    values: string[],
    pattern: string,
    matchType: "exact" | "contains" | "regex",
    caseSensitive: boolean,
  ): { candidate: string; regexMatch: RegExpExecArray | null } | null => {
    if (!pattern || values.length === 0) return null;
    if (matchType === "regex") {
      try {
        const regex = new RegExp(pattern, caseSensitive ? "" : "i");
        for (const value of values) {
          const match = regex.exec(value);
          if (match) return { candidate: value, regexMatch: match };
        }
      } catch {
        return null;
      }
      return null;
    }

    const needle = caseSensitive ? pattern : pattern.toLowerCase();
    for (const value of values) {
      const haystack = caseSensitive ? value : value.toLowerCase();
      if (matchType === "exact" && haystack === needle) return { candidate: value, regexMatch: null };
      if (matchType === "contains" && haystack.includes(needle)) return { candidate: value, regexMatch: null };
    }
    return null;
  };

  const renderLabelTemplate = (
    template: string,
    candidate: string,
    regexMatch: RegExpExecArray | null,
  ) => template
    .replace(/\$0/g, candidate)
    .replace(/\$(\d+)/g, (_, num) => {
      const idx = Number(num);
      if (!Number.isFinite(idx) || idx < 1) return "";
      return regexMatch?.[idx] ?? "";
    })
    .trim();

  const findLabelByNameInsensitive = (name: string) =>
    labelsState.labels.find((label) => label.name.trim().toLowerCase() === name.trim().toLowerCase());

  const enqueueAutoLabeling = (emails: EmailMessage[]) => {
    autoLabelQueue = autoLabelQueue
      .then(async () => {
        if (!emails.length) return;
        const rules = [...autoLabelRulesState.rules]
          .filter((rule) => rule.enabled && rule.pattern.trim().length > 0)
          .sort((a, b) => a.priority - b.priority);
        if (!rules.length) return;

        let appliedAny = false;

        for (const email of emails) {
          let mutableFlags = [...email.flags];
          for (const rule of rules) {
            const values = getDestinationValues(email, rule.targetField);
            const match = matchDestinationRule(values, rule.pattern, rule.matchType, rule.caseSensitive);
            if (!match) continue;

            let labelName = "";
            if (rule.labelMode === "fixed") {
              const fixedLabel = labelsState.labels.find((l) => l.id === rule.labelId);
              if (!fixedLabel) continue;
              labelName = fixedLabel.name;
            } else {
              labelName = renderLabelTemplate(rule.labelTemplate, match.candidate, match.regexMatch);
              if (!labelName) continue;
            }

            if (mutableFlags.includes(labelName)) {
              if (autoLabelRulesState.stopAfterFirstMatch) break;
              continue;
            }

            let label = findLabelByNameInsensitive(labelName);
            if (!label) {
              if (!autoLabelRulesState.autoCreateLabelsFromTemplate) continue;
              const createdId = addLabel(labelName, LABEL_COLORS[0]);
              if (!createdId) continue;
              label = labelsState.labels.find((l) => l.id === createdId) || findLabelByNameInsensitive(labelName);
            }
            if (!label) continue;

            const emailFolder = email.folderPath || "INBOX";
            const attemptKey = `${emailFolder.toLowerCase()}::${email.seq}::${rule.id}::${label.name}`;
            if (attemptedAutoLabelKeys.has(attemptKey)) continue;
            attemptedAutoLabelKeys.add(attemptKey);

            try {
              await addEmailLabel(String(email.seq), label.name, emailFolder);
              appliedAny = true;
              mutableFlags = [...mutableFlags, label.name];
              mutate((prev) => {
                if (!prev) return prev;
                return {
                  ...prev,
                  emails: prev.emails.map((row) =>
                    row.seq === email.seq && !row.flags.includes(label.name)
                      ? { ...row, flags: [...row.flags, label.name] }
                      : row
                  ),
                };
              });
              if (autoLabelRulesState.stopAfterFirstMatch) break;
            } catch (err) {
              console.error("[AutoLabel Error] Failed to apply label:", err);
            }
          }
        }

        if (appliedAny) {
          refreshCounts();
        }
      })
      .catch((err) => {
        console.error("[AutoLabel Error] Queue failure:", err);
      });
  };

  const requestInboxRefresh = async (force = false) => {
    if (!force && isImportActive()) return null;

    const now = Date.now();
    if (!force && now - lastRefreshAt < MIN_REFRESH_GAP_MS) {
      const wait = MIN_REFRESH_GAP_MS - (now - lastRefreshAt);
      if (!refreshQueueTimer) {
        refreshQueueTimer = setTimeout(() => {
          refreshQueueTimer = undefined;
          void requestInboxRefresh();
        }, wait);
      }
      return null;
    }

    if (refreshInFlight) {
      refreshQueued = true;
      return null;
    }

    if (refreshIndicatorTimer) {
      clearTimeout(refreshIndicatorTimer);
      refreshIndicatorTimer = undefined;
    }
    setRefreshIndicatorState("refreshing");
    refreshInFlight = true;
    let refreshFailed = false;
    try {
      const data = await silentRefresh();
      refreshCounts();
      lastRefreshAt = Date.now();
      return data;
    } catch (err) {
      refreshFailed = true;
      throw err;
    } finally {
      refreshInFlight = false;
      if (refreshQueued) {
        refreshQueued = false;
        void requestInboxRefresh();
      } else if (!refreshFailed) {
        setRefreshIndicatorState("success");
        refreshIndicatorTimer = setTimeout(() => {
          setRefreshIndicatorState("idle");
          refreshIndicatorTimer = undefined;
        }, 1200);
      } else {
        setRefreshIndicatorState("idle");
      }
    }
  };

  onCleanup(() => {
    if (refreshIndicatorTimer) clearTimeout(refreshIndicatorTimer);
  });

  const totalEmails = () => paginatedData()?.total ?? 0;
  const totalPages = () => Math.max(1, Math.ceil(totalEmails() / perPage()));
  const canGoNextPage = () => Boolean(paginatedData()?.hasMore);
  const isPageTransitionLoading = () => pendingPage() !== null && paginatedData.loading;
  const showListLoadingOverlay = () => networkLoadingPage() !== null || isPageTransitionLoading();

  const filteredEmails = createMemo(() => {
    const term = searchTerm().toLowerCase();
    let list = (paginatedData()?.emails || [])
      .filter((email) => Boolean(email))
      .map((email) => ({ ...email, flags: Array.isArray(email.flags) ? email.flags : [] }))
      .filter((email) => !isBlocked(email.fromAddress));

    const filter = labelsState.activeFilter;
    if (filter === "starred") {
      list = list.filter(e => e.flags.includes("\\Flagged"));
    } else if (filter === IMPORTANT_FILTER_ID) {
      list = list.filter((e) => e.flags.includes(IMPORTANT_LABEL_NAME));
    } else if (settings.enableCategories && filter && isCategoryFilterId(filter)) {
      const categoryKey = categoryKeyFromFilterId(filter);
      if (categoryKey && activeMailbox() === "INBOX") {
        if (categoryKey === PRIMARY_CATEGORY_KEY) {
          list = list.filter((e) => e.syncStatus !== "imap_synced" || matchesCategoryFlags(e.flags, categoryKey));
        } else {
          list = list.filter((e) => matchesCategoryFlags(e.flags, categoryKey));
        }
      }
    } else if (filter) {
      const label = getVisibleLabels().find((l) => l.id === filter);
      if (label) {
        list = list.filter(e => e.flags.includes(label.name));
      }
    }

    const withNew = list.map((e) => ({ ...e, isNew: newConversationKeys().has(conversationKey(e)) }));
    if (!term) return withNew;
    return withNew.filter(
      (e) =>
        e.subject.toLowerCase().includes(term) ||
        e.from.toLowerCase().includes(term)
    );
  });

  createEffect(() => {
    const mailbox = activeMailbox();
    if (mailbox !== "INBOX" && !mailbox.startsWith("inbox:primary")) return;
    const data = paginatedData();
    if (!data?.emails?.length) return;
    for (const email of data.emails) {
      if (!email?.fromAddress) continue;
      if (!isBlocked(email.fromAddress)) continue;
      if (blockedMovesInFlight.has(email.seq)) continue;
      const currentFolder = folderForSeq(email.seq);
      if (currentFolder.trim().toLowerCase() === "trash") continue;

      blockedMovesInFlight.add(email.seq);
      void (async () => {
        try {
          await moveToFolder(String(email.seq), currentFolder, "Trash");
          await silentRefresh();
          refreshCounts();
        } catch (err) {
          console.error("[UI Error] auto-move blocked sender failed:", err);
        } finally {
          blockedMovesInFlight.delete(email.seq);
        }
      })();
    }
  });

  // Defensive sync: keep thread selection aligned with selected email even if
  // selection changes outside the normal row-click path.
  createEffect(() => {
    const seq = selectedEmail();
    if (seq === null) {
      setSelectedThreadId(null);
      return;
    }
    const email = paginatedData()?.emails.find((e) => e.seq === seq);
    setSelectedThreadId(email?.threadId ?? null);
  });

  const markOpenedEmailAsRead = (seq: number) => {
    const current = paginatedData();
    if (!current) return;
    const email = current.emails.find((e) => e.seq === seq);
    if (!email || email.flags.includes("\\Seen")) return;
    const folder = email.folderPath || "INBOX";
    const previousFlags = mutateEmailFlags(seq, (flags) =>
      flags.includes("\\Seen") ? flags : [...flags, "\\Seen"],
    );
    clearNewBadgeForSeq(seq);
    // Keep reader opening local-first: sync remote read flag in background without
    // forcing an immediate global counts refresh/reconcile on click.
    void markAsRead(String(seq), folder)
      .then(() => {
        setTimeout(() => refreshCounts(), 250);
      })
      .catch((err) => {
        console.error("[UI Warning] markOpenedEmailAsRead sync failed:", err);
        if (previousFlags) mutateEmailFlags(seq, () => previousFlags);
        refreshCounts();
      });
  };

  const handleEmailClick = (seq: number) => {
    const folder = folderForSeq(seq);
    if (settings.readingPane === "none") {
      navigate(`/email/${seq}?folder=${encodeURIComponent(folder)}`);
      return;
    }

    // Always open reader immediately; do ancillary updates after.
    setSelectedEmail(seq);

    try {
      const email = filteredEmails().find(e => e.seq === seq);
      setSelectedThreadId(email?.threadId ?? null);
    } catch (err) {
      console.error("[UI Error] handleEmailClick thread selection:", err);
      setSelectedThreadId(null);
    }

    queueMicrotask(() => {
      try {
        clearNewBadgeForSeq(seq);
        void markOpenedEmailAsRead(seq);
      } catch (err) {
        console.error("[UI Error] handleEmailClick post actions:", err);
      }
    });
  };

  // --- Context menu ---
  const handleContextMenu = (seq: number, flags: string[], e: MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, seq, flags });
  };

  const contextMenuItems = (): ContextMenuItem[] => {
    const ctx = contextMenu();
    if (!ctx) return [];
    const folder = folderForSeq(ctx.seq);
    const isRead = ctx.flags.includes("\\Seen");
    const items: ContextMenuItem[] = [
      { label: "Reply", icon: IconReply, action: () => {
        navigate(`/email/${ctx.seq}?folder=${encodeURIComponent(folder)}`);
      }},
      { label: isRead ? "Mark as Unread" : "Mark as Read", icon: isRead ? IconEnvelope : IconEnvelopeOpen, action: async () => {
        await handleToggleRead(ctx.seq, !isRead);
      }},
      { label: "Archive", icon: IconArchive, action: async () => {
        await handleArchiveFromList(ctx.seq);
      }, divider: true },
      { label: "Snooze", icon: IconClock, action: () => {
        setPendingSnoozeTargets([{ seq: ctx.seq, folder }]);
        setSnoozeMenuPosition({ x: ctx.x, y: ctx.y });
      }},
      { label: "Move to Spam", icon: IconSpam, action: async () => {
        await moveToFolder(String(ctx.seq), folder, "Spam");
        await silentRefresh();
        refreshCounts();
      }},
      { label: "Block sender", icon: IconBlock, action: async () => {
        await handleBlockSender(ctx.seq);
      }, danger: true },
      { label: "Delete", icon: IconTrash, action: async () => {
        await handleDeleteFromList(ctx.seq);
      }, danger: true, divider: true },
    ];

    const labels = getVisibleLabels();
    items.push({
      label: "Labels",
      icon: IconLabel,
      children:
        labels.filter((label) => label.name !== IMPORTANT_LABEL_NAME).length > 0
          ? labels.filter((label) => label.name !== IMPORTANT_LABEL_NAME).map((label) => {
              const hasLabel = ctx.flags.includes(label.name);
              return {
              label: label.name,
              color: label.color,
              checked: hasLabel,
              action: async () => {
                if (hasLabel) {
                  await handleLabelRemove(ctx.seq, label.name);
                } else {
                  await handleLabelAdd(ctx.seq, label.name);
                }
              },
            };
          })
          : [{ label: "No labels available", disabled: true }],
    });
    return items;
  };

  const openActionsMenuForSelection = () => {
    if (contextMenu()) {
      setContextMenu(null);
      return true;
    }
    const seq = selectedEmail();
    if (seq === null) return false;
    const email = filteredEmails().find((item) => item.seq === seq);
    if (!email) return false;
    const x = Math.round(window.innerWidth / 2);
    const y = Math.round(window.innerHeight / 2);
    setContextMenu({ x, y, seq, flags: email.flags || [] });
    return true;
  };

  const openSnoozeMenuForSelection = () => {
    if (snoozeMenuPosition()) {
      setSnoozeMenuPosition(null);
      setPendingSnoozeTargets([]);
      return true;
    }
    const seqs = getActionSeqs();
    if (!seqs.length) return false;
    const x = Math.round(window.innerWidth / 2);
    const y = Math.round(window.innerHeight / 2);
    setPendingSnoozeTargets(seqs.map((seq) => ({ seq, folder: folderForSeq(seq) })));
    setSnoozeMenuPosition({ x, y });
    return true;
  };

  const openComposeForSelection = async (mode: "reply" | "reply-all" | "forward") => {
    const seq = selectedEmail();
    if (seq === null) return;
    const folder = folderForSeq(seq);
    try {
      const fullEmail = await getEmail(String(seq), folder);
      if (!fullEmail) return;

      const currentUser =
        fullEmail.accountEmail ||
        ((typeof process !== "undefined" ? process.env?.ADMIN_EMAIL : undefined) || "admin@local");

      if (mode === "reply") {
        const to = getReplyRecipients(fullEmail, currentUser);
        const subject = formatReplySubject(fullEmail.subject || "");
        const parts = getReplyQuoteParts(fullEmail);
        openCompose({
          to,
          subject,
          body: "",
          quotedEmail: { rawHtml: parts.rawHtml, headerHtml: parts.headerHtml, quoteType: "reply" },
        });
        return;
      }

      if (mode === "reply-all") {
        const recipients = getReplyAllRecipients(fullEmail, currentUser);
        const subject = formatReplySubject(fullEmail.subject || "");
        const parts = getReplyQuoteParts(fullEmail);
        openCompose({
          to: recipients.to,
          cc: recipients.cc,
          subject,
          body: "",
          quotedEmail: { rawHtml: parts.rawHtml, headerHtml: parts.headerHtml, quoteType: "reply" },
          showCc: recipients.cc.length > 0,
        });
        return;
      }

      const parts = getForwardQuoteParts(fullEmail);
      openCompose({
        to: [],
        subject: formatForwardSubject(fullEmail.subject || ""),
        body: "",
        quotedEmail: { rawHtml: parts.rawHtml, headerHtml: parts.headerHtml, quoteType: "forward" },
      });
    } catch (err) {
      console.error("[UI Error] open compose action failed:", err);
      showToast("Unable to prepare compose action", "error");
    }
  };

  // --- Helpers ---
  const allSelected = () => { const list = filteredEmails(); return list.length > 0 && selectedEmails().size === list.length; };
  const someSelected = () => { const sel = selectedEmails(); return sel.size > 0 && sel.size < filteredEmails().length; };
  const toggleSelectAll = () => { if (allSelected()) setSelectedEmails(new Set()); else setSelectedEmails(new Set(filteredEmails().map(e => e.seq))); };
  const handleCheckedChange = (seq: number, checked: boolean) => { setSelectedEmails(prev => { const next = new Set(prev); if (checked) next.add(seq); else next.delete(seq); return next; }); };
  const getActionSeqs = () => {
    const selected = Array.from(selectedEmails());
    if (selected.length > 0) return selected;
    const active = selectedEmail();
    return active !== null ? [active] : [];
  };
  const handleBatchDelete = async () => {
    const seqs = getActionSeqs();
    if (!seqs.length) return;
    const folderBuckets = new Map<string, string[]>();
    for (const seq of seqs) {
      const folder = folderForSeq(seq);
      const bucket = folderBuckets.get(folder) || [];
      bucket.push(String(seq));
      folderBuckets.set(folder, bucket);
    }
    for (const [folder, values] of folderBuckets.entries()) {
      await deleteEmailsBatch(values, folder);
    }
    if (selectedEmail() && seqs.includes(selectedEmail()!)) setSelectedEmail(null);
    setSelectedEmails(new Set());
    await silentRefresh();
    refreshCounts();
  };
  const handleBatchArchive = async () => {
    const seqs = getActionSeqs();
    if (!seqs.length) return;
    const folderBuckets = new Map<string, string[]>();
    for (const seq of seqs) {
      const folder = folderForSeq(seq);
      const bucket = folderBuckets.get(folder) || [];
      bucket.push(String(seq));
      folderBuckets.set(folder, bucket);
    }
    for (const [folder, values] of folderBuckets.entries()) {
      await archiveEmails(values, folder);
    }
    if (selectedEmail() && seqs.includes(selectedEmail()!)) setSelectedEmail(null);
    setSelectedEmails(new Set());
    await silentRefresh();
    refreshCounts();
  };
  const handleDeleteFromList = async (seq: number) => { await deleteEmail(String(seq), folderForSeq(seq)); if (selectedEmail() === seq) setSelectedEmail(null); await silentRefresh(); refreshCounts(); };
  const handleArchiveFromList = async (seq: number) => { await archiveEmails([String(seq)], folderForSeq(seq)); if (selectedEmail() === seq) setSelectedEmail(null); await silentRefresh(); refreshCounts(); };
  const mutateEmailFlags = (seq: number, updater: (flags: string[]) => string[]) => {
    let previousFlags: string[] | null = null;
    mutate((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        emails: prev.emails.map((email) => {
          if (!email || typeof email.seq !== "number") return email;
          if (email.seq !== seq) return email;
          const currentFlags = Array.isArray(email.flags) ? email.flags : [];
          previousFlags = [...currentFlags];
          return { ...email, flags: updater(currentFlags) };
        }),
      };
    });
    return previousFlags;
  };

  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const commitFlagChangeWithTolerance = async (
    seq: number,
    flag: string,
    expected: boolean,
    applyRemote: () => Promise<void>,
    previousFlags: string[] | null,
  ) => {
    const retryDelays = [900, 1700, 2800];

    for (let attempt = 0; attempt < retryDelays.length; attempt += 1) {
      try {
        await applyRemote();
      } catch (err) {
        console.error(`[UI Warning] flag sync attempt ${attempt + 1} failed:`, err);
      }

      const refreshed = await silentRefresh();
      refreshCounts();

      const remoteHasFlag = Boolean(
        refreshed?.emails.find((email) => email.seq === seq)?.flags.includes(flag),
      );
      if (remoteHasFlag === expected) return;

      await wait(retryDelays[attempt]);
    }

    // Final grace window for very slow backends before reverting optimistic state.
    await wait(3500);
    const finalRefresh = await silentRefresh();
    refreshCounts();
    const finalHasFlag = Boolean(
      finalRefresh?.emails.find((email) => email.seq === seq)?.flags.includes(flag),
    );
    if (finalHasFlag === expected) return;

    if (previousFlags) {
      mutateEmailFlags(seq, () => previousFlags);
      refreshCounts();
    }
  };

  const handleStar = async (seq: number, starred: boolean) => {
    const previousFlags = mutateEmailFlags(seq, (flags) => {
      const hasStar = flags.includes("\\Flagged");
      if (starred && !hasStar) return [...flags, "\\Flagged"];
      if (!starred && hasStar) return flags.filter((f) => f !== "\\Flagged");
      return flags;
    });
    refreshCounts();
    void commitFlagChangeWithTolerance(
      seq,
      "\\Flagged",
      starred,
      () => toggleStar(String(seq), starred, folderForSeq(seq)),
      previousFlags,
    );
  };
  const handleImportantToggle = async (seq: number, important: boolean) => {
    const previousFlags = mutateEmailFlags(seq, (flags) => {
      const hasImportant = flags.includes(IMPORTANT_LABEL_NAME);
      if (important && !hasImportant) return [...flags, IMPORTANT_LABEL_NAME];
      if (!important && hasImportant) return flags.filter((f) => f !== IMPORTANT_LABEL_NAME);
      return flags;
    });
    refreshCounts();
    void commitFlagChangeWithTolerance(
      seq,
      IMPORTANT_LABEL_NAME,
      important,
      () =>
        important
          ? addEmailLabel(String(seq), IMPORTANT_LABEL_NAME, folderForSeq(seq))
          : removeEmailLabel(String(seq), IMPORTANT_LABEL_NAME, folderForSeq(seq)),
      previousFlags,
    );
  };
  const handleLabelAdd = async (seq: number, label: string) => {
    const previousFlags = mutateEmailFlags(seq, (flags) =>
      flags.includes(label) ? flags : [...flags, label],
    );
    refreshCounts();
    void commitFlagChangeWithTolerance(
      seq,
      label,
      true,
      () => addEmailLabel(String(seq), label, folderForSeq(seq)),
      previousFlags,
    );
  };
  const handleLabelRemove = async (seq: number, label: string) => {
    const previousFlags = mutateEmailFlags(seq, (flags) =>
      flags.includes(label) ? flags.filter((f) => f !== label) : flags,
    );
    refreshCounts();
    void commitFlagChangeWithTolerance(
      seq,
      label,
      false,
      () => removeEmailLabel(String(seq), label, folderForSeq(seq)),
      previousFlags,
    );
  };
  const handleToggleRead = async (seq: number, makeRead: boolean) => {
    const folder = folderForSeq(seq);
    const previousFlags = mutateEmailFlags(seq, (flags) => {
      const hasSeen = flags.includes("\\Seen");
      if (makeRead && !hasSeen) return [...flags, "\\Seen"];
      if (!makeRead && hasSeen) return flags.filter((f) => f !== "\\Seen");
      return flags;
    });
    refreshCounts();
    if (makeRead) clearNewBadgeForSeq(seq);
    void commitFlagChangeWithTolerance(
      seq,
      "\\Seen",
      makeRead,
      () => (makeRead ? markAsRead(String(seq), folder) : markAsUnread(String(seq), folder)),
      previousFlags,
    );
  };
  const handleBatchMarkRead = async (read: boolean) => {
    const seqs = getActionSeqs();
    if (!seqs.length) return;
    for (const seq of seqs) {
      const folder = folderForSeq(seq);
      if (read) await markAsRead(String(seq), folder);
      else await markAsUnread(String(seq), folder);
    }
    await silentRefresh();
    refreshCounts();
  };
  const handleBatchMoveToSpam = async () => {
    const seqs = getActionSeqs();
    if (!seqs.length) return;
    for (const seq of seqs) {
      await moveToFolder(String(seq), folderForSeq(seq), "Spam");
    }
    if (selectedEmail() && seqs.includes(selectedEmail()!)) setSelectedEmail(null);
    setSelectedEmails(new Set());
    await silentRefresh();
    refreshCounts();
  };
  const handleBlockSender = async (seq: number) => {
    const email = paginatedData()?.emails.find((e) => e.seq === seq);
    if (!email?.fromAddress) {
      showToast("Cannot block: sender address unknown", "error");
      return;
    }
    const folder = folderForSeq(seq);
    await blockSender(email.fromAddress, email.from || "");
    await moveToFolder(String(seq), folder, "Trash");
    if (selectedEmail() === seq) setSelectedEmail(null);
    await silentRefresh();
    refreshCounts();
    void refetchBlocked();
    showToast(`Blocked ${email.fromAddress}`, "success");
  };
  const handleBatchBlockSenders = async () => {
    const seqs = getActionSeqs();
    if (!seqs.length) return;
    const rows = (paginatedData()?.emails ?? []).filter((email) => seqs.includes(email.seq));
    const targetRows = rows.filter((email) => email.fromAddress);
    if (!targetRows.length) {
      showToast("Cannot block: sender address unknown", "error");
      return;
    }

    const senderMap = new Map<string, string>();
    for (const row of targetRows) {
      const senderEmail = (row.fromAddress || "").trim().toLowerCase();
      if (!senderEmail || senderMap.has(senderEmail)) continue;
      senderMap.set(senderEmail, row.from || "");
    }

    for (const [senderEmail, displayName] of senderMap.entries()) {
      await blockSender(senderEmail, displayName);
    }
    for (const row of targetRows) {
      await moveToFolder(String(row.seq), folderForSeq(row.seq), "Trash");
    }

    if (selectedEmail() && seqs.includes(selectedEmail()!)) setSelectedEmail(null);
    setSelectedEmails(new Set());
    await silentRefresh();
    refreshCounts();
    void refetchBlocked();
    showToast(`Blocked ${senderMap.size} sender${senderMap.size === 1 ? "" : "s"}`, "success");
  };

  const handleSnoozeTargets = async (targets: Array<{ seq: number; folder: string }>, until: Date) => {
    if (!targets.length) {
      showToast("No email selected to snooze", "error");
      return;
    }
    try {
      const untilIso = until.toISOString();
      const folderBuckets = new Map<string, string[]>();
      for (const { seq, folder } of targets) {
        const bucket = folderBuckets.get(folder) || [];
        bucket.push(String(seq));
        folderBuckets.set(folder, bucket);
      }
      for (const [folder, values] of folderBuckets.entries()) {
        await snoozeEmails(values, folder, untilIso);
      }
      const targetSeqs = new Set(targets.map((t) => t.seq));
      if (selectedEmail() && targetSeqs.has(selectedEmail()!)) setSelectedEmail(null);
      setSelectedEmails(new Set());
      await silentRefresh();
      refreshCounts();
      showToast("Email snoozed", "success");
    } catch (err) {
      console.error("[UI Error] snooze failed:", err);
      showToast("Could not snooze email", "error");
    }
    setPendingSnoozeTargets([]);
  };
  const openSnoozeMenuAtElement = (
    anchor: HTMLElement | null,
    targets: Array<{ seq: number; folder: string }>,
  ) => {
    if (!anchor || !targets.length) return;
    setPendingSnoozeTargets(targets);
    const rect = anchor.getBoundingClientRect();
    setSnoozeMenuPosition({ x: rect.left, y: rect.bottom + 8 });
  };
  const openSnoozeMenu = (e: MouseEvent) => {
    const seqs = getActionSeqs();
    if (!seqs.length) return;
    const button = e.currentTarget as HTMLElement | null;
    openSnoozeMenuAtElement(
      button,
      seqs.map((seq) => ({ seq, folder: folderForSeq(seq) })),
    );
  };
  const handlePaneSnooze = (seq: number, e: MouseEvent) => {
    const button = e.currentTarget as HTMLElement | null;
    openSnoozeMenuAtElement(button, [{ seq, folder: folderForSeq(seq) }]);
  };
  const handleMoveToSpamFromPane = async (seq: number) => {
    await moveToFolder(String(seq), folderForSeq(seq), "Spam");
    if (selectedEmail() === seq) setSelectedEmail(null);
    await silentRefresh();
    refreshCounts();
  };
  const handleDeletedFromPane = () => { setSelectedEmail(null); setSelectedThreadId(null); void silentRefresh(); refreshCounts(); };
  const draggedEmailCount = () => draggedEmailSeqs().length;
  const seqsForRowDrag = (seq: number): number[] => {
    const selected = selectedEmails();
    if (selected.size > 1 && selected.has(seq)) return Array.from(selected);
    return [seq];
  };
  const clearDragState = () => {
    setDraggedEmailSeqs([]);
    setDragOverCategoryKey(null);
    setPointerDragActive(false);
    pointerDragOrigin = null;
    pointerDragStarted = false;
    categoryTabRects = [];
    if (dragPreviewEl) {
      dragPreviewEl.remove();
      dragPreviewEl = null;
    }
    if (pointerDragCleanup) {
      pointerDragCleanup();
      pointerDragCleanup = null;
    }
  };

  const createDragPreview = (count: number): HTMLDivElement => {
    if (dragPreviewEl) {
      dragPreviewEl.remove();
      dragPreviewEl = null;
    }
    const label = count === 1 ? "message" : "messages";
    const preview = document.createElement("div");
    preview.setAttribute("data-testid", "drag-preview-box");
    preview.style.cssText = "position:fixed;z-index:99999;pointer-events:none;transform:translate(-50%,-100%);";
    preview.className = "rounded-xl border border-[var(--primary)] bg-[var(--card)] px-3 py-2 shadow-lg";
    preview.innerHTML = `<div style="font-size:12px;font-weight:600;color:var(--primary)">Move ${count} ${label}</div><div style="font-size:11px;color:var(--text-secondary)">Drop on a category to move</div>`;
    document.body.appendChild(preview);
    dragPreviewEl = preview;
    return preview;
  };

  const snapshotCategoryTabRects = () => {
    categoryTabRects = [];
    // Capture tab buttons
    const tabs = document.querySelectorAll<HTMLElement>('[data-testid^="category-drop-tab-"]');
    tabs.forEach((tab) => {
      const key = tab.getAttribute("data-testid")?.replace("category-drop-tab-", "") || "";
      if (key) categoryTabRects.push({ key, rect: tab.getBoundingClientRect() });
    });
    // Also capture drop-hint areas (visible once drag is active)
    const hints = document.querySelectorAll<HTMLElement>('[data-testid^="category-drop-hint-"]');
    hints.forEach((hint) => {
      const key = hint.getAttribute("data-testid")?.replace("category-drop-hint-", "") || "";
      if (key) categoryTabRects.push({ key, rect: hint.getBoundingClientRect() });
    });
  };

  const hitTestCategoryTab = (x: number, y: number): string | null => {
    for (const { key, rect } of categoryTabRects) {
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return key;
    }
    return null;
  };

  const handlePointerDragStart = (seq: number, e: PointerEvent, suppressClick?: () => void) => {
    // Record the origin; actual drag activation happens after threshold movement.
    pointerDragOrigin = { x: e.clientX, y: e.clientY, seq };
    pointerDragStarted = false;
    let needsHintResnapshot = false;

    const onPointerMove = (moveEvent: PointerEvent) => {
      if (!pointerDragOrigin) return;

      if (!pointerDragStarted) {
        const dx = moveEvent.clientX - pointerDragOrigin.x;
        const dy = moveEvent.clientY - pointerDragOrigin.y;
        if (Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return;

        // Threshold exceeded → activate drag and suppress the pending click
        pointerDragStarted = true;
        suppressClick?.();
        const dragSeqs = seqsForRowDrag(pointerDragOrigin.seq);
        setDraggedEmailSeqs(dragSeqs);
        setPointerDragActive(true);
        snapshotCategoryTabRects();
        createDragPreview(dragSeqs.length);
        // Drop-hint elements render on the next frame; re-snapshot to include them
        needsHintResnapshot = true;
      }

      // Re-snapshot once after hints have rendered into the DOM
      if (needsHintResnapshot) {
        needsHintResnapshot = false;
        snapshotCategoryTabRects();
      }

      // Move the preview
      if (dragPreviewEl) {
        dragPreviewEl.style.left = `${moveEvent.clientX}px`;
        dragPreviewEl.style.top = `${moveEvent.clientY - 8}px`;
      }

      // Hit-test category tabs
      const hitKey = hitTestCategoryTab(moveEvent.clientX, moveEvent.clientY);
      if (dragOverCategoryKey() !== hitKey) setDragOverCategoryKey(hitKey);
    };

    const onPointerUp = async (upEvent: PointerEvent) => {
      const dropTarget = dragOverCategoryKey();
      const seqs = [...draggedEmailSeqs()];
      const wasActive = pointerDragStarted;

      // Clean up listeners first
      clearDragState();

      // Re-suppress click so the upcoming click event (from pointerup) doesn't open the email
      if (wasActive) suppressClick?.();

      if (!wasActive || !dropTarget || seqs.length === 0) return;

      // Perform the drop
      categoryDropInProgress = true;
      lastCategoryDropAt = Date.now();
      try {
        const emailMap = new Map((paginatedData()?.emails || []).map((email) => [email.seq, email]));
        for (const s of seqs) {
          await assignEmailToCategory(s, dropTarget, emailMap.get(s));
        }
        await silentRefresh();
        refreshCounts();
        setSelectedEmails(new Set());
      } finally {
        categoryDropInProgress = false;
      }
    };

    const onKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key === "Escape") clearDragState();
    };

    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp, { once: true });
    document.addEventListener("keydown", onKeyDown);

    pointerDragCleanup = () => {
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("keydown", onKeyDown);
    };
  };
  const applyCategoryLabelChange = async (
    seq: number,
    folder: string,
    labelName: string,
    shouldAdd: boolean,
  ) => {
    const retryDelays = [0, 250, 750];
    let lastErr: unknown = null;
    for (const delay of retryDelays) {
      if (delay > 0) await wait(delay);
      try {
        if (shouldAdd) await addEmailLabel(String(seq), labelName, folder);
        else await removeEmailLabel(String(seq), labelName, folder);
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    console.error(`[UI Warning] failed to ${shouldAdd ? "add" : "remove"} category label`, {
      seq,
      labelName,
      folder,
      err: lastErr,
    });
  };
  const assignEmailToCategory = async (
    seq: number,
    categoryKey: string,
    emailOverride?: { seq: number; flags?: string[]; folderPath?: string },
  ) => {
    const email = emailOverride || (paginatedData()?.emails || []).find((row) => row && row.seq === seq);
    if (!email) return;
    const emailFlags = Array.isArray(email.flags) ? email.flags : [];
    const folder = email.folderPath || folderForSeq(seq);

    const configuredCategoryMap = new Map(configuredCategories().map((category) => [category.key, category.name]));
    const targetCategoryName = categoryKey === PRIMARY_CATEGORY_KEY ? null : configuredCategoryMap.get(categoryKey) || null;
    const targetLabel = targetCategoryName ? `Category ${targetCategoryName}` : null;
    const labelsToRemove = emailFlags.filter((flag) => {
      const categoryName = getCategoryNameFromLabel(flag);
      if (!categoryName) return false;
      if (targetLabel && flag === targetLabel) return false;
      return configuredCategoryMap.has(normalizeCategoryNameToKey(categoryName));
    });

    for (const labelName of labelsToRemove) {
      await applyCategoryLabelChange(seq, folder, labelName, false);
    }

    if (categoryKey === PRIMARY_CATEGORY_KEY) return;
    if (!targetLabel) return;
    if (!emailFlags.includes(targetLabel)) {
      await applyCategoryLabelChange(seq, folder, targetLabel, true);
    }
  };
  const actionSelectionCount = () => {
    const selected = selectedEmails().size;
    if (selected > 0) return selected;
    return selectedEmail() === null ? 0 : 1;
  };
  const hasActionSelection = () => actionSelectionCount() > 0;

  const currentIndex = createMemo(() => (selectedEmail() === null ? -1 : filteredEmails().findIndex(e => e.seq === selectedEmail())));
  const hasPrevious = () => currentIndex() > 0;
  const hasNext = () => currentIndex() >= 0 && currentIndex() < filteredEmails().length - 1;
  const goToPrevious = () => {
    if (!hasPrevious()) return;
    handleEmailClick(filteredEmails()[currentIndex() - 1].seq);
  };
  const goToNext = () => {
    if (!hasNext()) return;
    handleEmailClick(filteredEmails()[currentIndex() + 1].seq);
  };

  // Pagination
  const goToPage = (page: number) => {
    if (page < 1) return;
    if (effectiveThreaded() && page > totalPages()) return;
    if (!effectiveThreaded()) {
      if (page === 1) {
        setCurrentCursor(null);
      } else {
        const cursor = pageCursors().get(pageCacheKey(page));
        if (!cursor) return;
        setCurrentCursor(cursor);
      }
    }
    const cached = pageCache().get(pageCacheKey(page));
    if (cached) mutate(cached);
    setLastPageNavAt(Date.now());
    setPendingPage(page);
    setCurrentPage(page);
    setSelectedEmail(null);
    setSelectedEmails(new Set());
  };

  const pageRangeText = () => {
    if (paginatedData.loading && !paginatedData()) return "Loading...";
    const total = totalEmails();
    if (total === 0) return "0 of 0";
    const start = (currentPage() - 1) * perPage() + 1;
    const end = Math.min(currentPage() * perPage(), total);
    return `${start}\u2013${end} of ${total}`;
  };

  // --- Resize Logic ---
  const handleMouseDown = (e: MouseEvent) => { e.preventDefault(); setIsResizing(true); };
  const handleMouseMove = (e: MouseEvent) => {
    if (!isResizing()) return;
    if (settings.readingPane === "right") {
      const minSize = 300;
      const maxSize = window.innerWidth - 300;
      const newWidth = window.innerWidth - e.clientX;
      setPaneSize(Math.max(minSize, Math.min(newWidth, maxSize)));
    } else if (settings.readingPane === "bottom") {
      const minSize = 200;
      const maxSize = window.innerHeight - 200;
      const newHeight = window.innerHeight - e.clientY;
      setPaneSize(Math.max(minSize, Math.min(newHeight, maxSize)));
    }
  };
  const handleMouseUp = () => {
    setIsResizing(false);
    if (typeof window !== "undefined") {
      localStorage.setItem("paneSize", String(paneSize()));
    }
  };

  // Real-time updates via SSE (instant push from sync engine)
  const { trigger: mailEventTrigger, lastEvent } = useMailEvents();

  createEffect(() => {
    const t = mailEventTrigger();
    if (t === 0) return; // Skip initial value
    if (isImportActive()) return; // Reduce UI churn while bulk import is active.
    const evt = lastEvent();
    void (async () => {
      const data = await requestInboxRefresh();
      if (activeMailbox() !== "INBOX" && !activeMailbox().startsWith("inbox:primary")) return;
      if (evt?.type !== "new_message" || !evt.uid || (evt.folder || "").toUpperCase() !== "INBOX") return;
      const found = data?.emails?.find((e) => e.seq === evt.uid);
      if (!found) return;
      if (isBlocked(found.fromAddress)) {
        await moveToFolder(String(found.seq), found.folderPath || "INBOX", "Trash");
        await requestInboxRefresh(true);
        refreshCounts();
        return;
      }
      enqueueAutoLabeling([found]);
      const key = conversationKey(found);
      setNewConversationKeys((prev) => {
        const next = new Set(prev);
        next.add(key);
        return next;
      });
    })();
  });

  createEffect(() => {
    const rulesSignature = autoLabelRulesState.rules
      .map((r) => `${r.id}:${r.enabled ? 1 : 0}:${r.priority}:${r.targetField}:${r.matchType}:${r.caseSensitive ? 1 : 0}:${r.labelMode}:${r.labelId}:${r.labelTemplate}:${r.pattern}`)
      .join("|") + `|stop=${autoLabelRulesState.stopAfterFirstMatch ? 1 : 0}|create=${autoLabelRulesState.autoCreateLabelsFromTemplate ? 1 : 0}`;
    void rulesSignature;
    const data = paginatedData();
    if (!data?.emails?.length) return;
    enqueueAutoLabeling(data.emails);
  });

  createEffect(() => {
    if (location.pathname !== "/") return;
    const queryFilter = new URLSearchParams(location.search).get("filter");
    const normalized = queryFilter
      ? queryFilter.startsWith("label:")
        ? queryFilter.slice("label:".length)
        : queryFilter
      : null;
    if (labelsState.activeFilter !== normalized) {
      setActiveFilter(normalized);
    }
  });

  createEffect(() => {
    const filter = labelsState.activeFilter;
    if (!filter || !isCategoryFilterId(filter)) return;
    if (!settings.enableCategories) {
      setActiveFilter(null);
      return;
    }
    const key = categoryKeyFromFilterId(filter);
    if (!key) {
      setActiveFilter(null);
      return;
    }
    if (!isConfiguredCategoryKey(key)) {
      setActiveFilter(null);
    }
  });

  createEffect(() => {
    const threaded = effectiveThreaded();
    const folder = activeMailbox();
    const pp = perPage();
    void threaded;
    void folder;
    void pp;
    setCurrentPage(1);
    setCurrentCursor(null);
    setPageCursors(new Map());
    setPageCache(new Map());
  });

  const adaptivePrefetchDepth = () => {
    if (typeof window === "undefined") return 2;
    if (document.visibilityState !== "visible") return 1;
    const conn = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string; downlink?: number } }).connection;
    if (conn?.saveData) return 1;
    const effective = (conn?.effectiveType || "").toLowerCase();
    if (effective.includes("2g")) return 1;
    if (effective === "3g") return 2;
    const downlink = Number(conn?.downlink || 0);
    const recentlyPaging = Date.now() - lastPageNavAt() < 12000;
    if (downlink >= 10) return recentlyPaging ? 5 : 3;
    if (downlink >= 3) return recentlyPaging ? 4 : 2;
    return recentlyPaging ? 3 : 2;
  };

  // Hidden prefetch: warm upcoming pages in cache to make page changes near-instant.
  createEffect(() => {
    const threaded = effectiveThreaded();
    const folder = activeMailbox();
    const page = currentPage();
    const pp = perPage();
    const data = paginatedData();
    void folder;
    if (!data?.hasMore) return;
    const depth = Math.min(5, Math.max(1, adaptivePrefetchDepth()));
    let cancelled = false;
    onCleanup(() => {
      cancelled = true;
    });

    void (async () => {
      let prevData = data;
      for (let step = 1; step <= depth; step += 1) {
        if (cancelled || !prevData?.hasMore) return;
        const targetPage = page + step;
        const cachedTarget = pageCache().get(pageCacheKey(targetPage));
        if (cachedTarget) {
          prevData = cachedTarget;
          continue;
        }

        const cursor = pageCursors().get(pageCacheKey(targetPage));
        if (!threaded && !cursor) return;
        if (prefetchInFlight.has(targetPage)) return;

        prefetchInFlight.add(targetPage);
        try {
          const nextData = threaded
            ? await fetchThreadsPaginated(folder, targetPage, pp)
            : await fetchEmailsPaginated(folder, targetPage, pp, cursor);

          if (cancelled) return;
          storePageData(targetPage, nextData, threaded);
          prevData = nextData;
        } finally {
          prefetchInFlight.delete(targetPage);
        }
      }
    })();
  });

  createEffect(() => {
    if (isImportActive()) return;
    void requestInboxRefresh(true);
  });

  createEffect(() => {
    if (!paginatedData.loading && pendingPage() !== null && Boolean(paginatedData())) {
      setPendingPage(null);
    }
  });

  onMount(() => {
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  });
  onCleanup(() => {
    if (isServer) return;
    if (refreshQueueTimer) clearTimeout(refreshQueueTimer);
    clearDragState();
    document.removeEventListener("mousemove", handleMouseMove);
    document.removeEventListener("mouseup", handleMouseUp);
  });

  const isVertical = () => settings.readingPane === "bottom";
  const isNone = () => settings.readingPane === "none";
  const showPane = () => !isNone() && selectedEmail() !== null;
  const selectedFolder = () => {
    const seq = selectedEmail();
    if (seq === null) return "INBOX";
    return folderForSeq(seq);
  };

  // When full-space mode is on, hide email list and show reading pane full width
  const isFullSpace = () => fullSpacePane() && selectedEmail() !== null;

  // Reset full-space when email is deselected
  const handleCloseEmail = () => {
    setFullSpacePane(false);
    setSelectedEmail(null);
    setSelectedThreadId(null);
  };

  const heading = () => {
    const filter = labelsState.activeFilter;
    if (filter === "starred") return "Starred";
    if (filter === IMPORTANT_FILTER_ID) return "Important";
    if (settings.enableCategories && filter && isCategoryFilterId(filter)) {
      const key = categoryKeyFromFilterId(filter);
      const tab = categoryTabs().find((item) => item.key === key);
      return tab?.name || "Inbox";
    }
    if (filter) {
      const label = getVisibleLabels().find((l) => l.id === filter);
      return label ? label.name : "Inbox";
    }
    return "Inbox";
  };

  return (
    <div
      class={`flex flex-1 h-full overflow-hidden ${isVertical() ? "flex-col" : "flex-row"}`}
      style={{ cursor: isResizing() ? (isVertical() ? "row-resize" : "col-resize") : undefined }}
    >
      {/* Email List Panel */}
      <div
        class={`flex flex-col overflow-hidden ${isFullSpace() ? "hidden" : ""}`}
        data-testid="mail-list-panel"
        style={{
          width: !isVertical() && showPane() && !isFullSpace() ? `calc(100% - ${paneSize()}px)` : "100%",
          height: isVertical() && showPane() && !isFullSpace() ? `calc(100% - ${paneSize()}px)` : "100%",
          "flex-shrink": 0,
        }}
      >
        {/* Inbox Header */}
        <div class="flex items-center justify-between px-6 py-4 border-b border-[var(--border-light)] bg-[var(--card)] shrink-0">
          <div class="flex items-center gap-3">
            <h1 class="text-xl font-semibold text-[var(--foreground)]">{heading()}</h1>
            <Show when={labelsState.activeFilter}>
              <button
                onClick={() => {
                  void navigate("/");
                }}
                class="flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium text-[var(--text-secondary)] bg-[var(--search-bg)] hover:bg-[var(--hover-bg)] border-none cursor-pointer transition-colors"
              >
                <IconClose size={12} />
                Clear filter
              </button>
            </Show>
          </div>
          <div class="flex items-center gap-2">
            <div class="relative">
              <svg class="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
              <input type="text" placeholder="Filter emails..." value={searchTerm()} onInput={(e) => setSearchTerm(e.currentTarget.value)} class="h-9 pl-10 pr-4 border border-[var(--border)] rounded-full bg-transparent text-sm text-[var(--foreground)] outline-none transition-all focus:border-[var(--primary)] focus:shadow-sm placeholder:text-[var(--text-muted)]" />
            </div>
            <button
              onClick={() => void requestInboxRefresh(true)}
              class={`w-9 h-9 rounded-full border-none bg-transparent cursor-pointer flex items-center justify-center transition-colors ${
                refreshIndicatorState() === "success"
                  ? "text-emerald-600 bg-emerald-100/70 hover:bg-emerald-100/90"
                  : "text-[var(--text-secondary)] hover:bg-[var(--hover-bg)]"
              }`}
              data-testid="inbox-refresh-button"
              data-state={refreshIndicatorState()}
              title={`Refresh${getActionShortcutHint("refreshEmails")}`}
            >
              <Show
                when={refreshIndicatorState() === "refreshing"}
                fallback={
                  <Show when={refreshIndicatorState() === "success"} fallback={<span data-testid="inbox-refresh-idle-icon"><IconRefresh size={18} /></span>}>
                    <span data-testid="inbox-refresh-success-icon"><IconCheck size={18} /></span>
                  </Show>
                }
              >
                <span data-testid="inbox-refresh-spinning-icon"><IconRefresh size={18} class="animate-spin" /></span>
              </Show>
            </button>
          </div>
        </div>

        <Show when={shouldShowCategoryTabs()}>
          <div class="flex flex-col w-full border-b border-[var(--border-light)] bg-[var(--card)] shrink-0" data-testid="mail-category-tabs">
            <div class="flex items-center w-full">
            <For each={categoryTabs()}>
              {(tab) => {
                const isActiveCategory = () => activeCategoryKey() === tab.key;
                const CategoryIcon = categoryIconById(tab.icon);
                return (
                  <div class="flex-1 min-w-0 flex flex-col">
                    <button
                      data-testid={`category-drop-tab-${tab.key}`}
                      class={`min-w-0 px-4 py-3 text-sm font-medium border-none bg-transparent cursor-pointer border-b-2 transition-colors inline-flex items-center gap-2 justify-center ${
                        dragOverCategoryKey() === tab.key
                          ? "text-[var(--primary)] border-[var(--primary)] bg-[var(--active-bg)] scale-[1.01]"
                          : isActiveCategory()
                          ? "text-[var(--primary)] border-[var(--primary)]"
                          : draggedEmailCount() > 0
                            ? "text-[var(--text-secondary)] border-transparent hover:bg-[var(--hover-bg)]"
                            : "text-[var(--text-secondary)] border-transparent hover:bg-[var(--hover-bg)]"
                      }`}
                      onClick={(e) => {
                        if (pointerDragActive() || categoryDropInProgress) {
                          e.preventDefault();
                          return;
                        }
                        const nextFilter = tab.key === PRIMARY_CATEGORY_KEY ? null : tab.filterId;
                        void navigate(nextFilter ? `/?filter=${encodeURIComponent(nextFilter)}` : "/");
                      }}
                    >
                      <CategoryIcon size={16} />
                      {tab.name}
                    </button>
                    <Show when={draggedEmailCount() > 0}>
                      <div
                        data-testid={`category-drop-hint-${tab.key}`}
                        class={`px-2 py-1.5 text-center text-[11px] transition-colors border-b ${
                          dragOverCategoryKey() === tab.key
                            ? "text-[var(--primary)] bg-[var(--active-bg)] border-[var(--primary)]"
                            : "text-[var(--text-muted)] bg-[var(--search-bg)] border-[var(--border-light)]"
                        }`}
                      >
                        Drag here to move {draggedEmailCount()} {draggedEmailCount() === 1 ? "message" : "messages"}
                      </div>
                    </Show>
                  </div>
                );
              }}
            </For>
            </div>
          </div>
        </Show>

        {/* Toolbar */}
        <div class="flex items-center gap-1 px-4 py-2 border-b border-[var(--border-light)] bg-[var(--card)] min-h-10 shrink-0" data-testid="mail-actions-toolbar">
          <div class="flex items-center gap-0.5 mr-2">
            <input type="checkbox" class="mail-checkbox cursor-pointer" checked={allSelected()} ref={(el) => { createMemo(() => { el.indeterminate = someSelected(); }); }} onChange={toggleSelectAll} />
          </div>
          <div
            data-testid="mail-list-bulk-actions"
            class={`flex items-center gap-1 ${hasActionSelection() ? "visible" : "invisible pointer-events-none"}`}
            aria-hidden={!hasActionSelection()}
          >
            <Show when={actionSelectionCount() > 1}>
              <span class="text-xs text-[var(--primary)] font-medium mr-1">{actionSelectionCount()} selected</span>
            </Show>
            <button class="w-9 h-9 rounded-full border-none bg-transparent cursor-pointer flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--primary)] transition-colors" title={`Archive${getActionShortcutHint("archiveConversation")}`} onClick={handleBatchArchive}><IconArchive size={18} /></button>
            <button class="w-9 h-9 rounded-full border-none bg-transparent cursor-pointer flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--primary)] transition-colors" title={`Snooze${getActionShortcutHint("openSnoozeMenu")}`} onClick={openSnoozeMenu}><IconClock size={18} /></button>
            <button class="w-9 h-9 rounded-full border-none bg-transparent cursor-pointer flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--destructive)] transition-colors" title={`Delete${getActionShortcutHint("deleteConversation")}`} onClick={handleBatchDelete}><IconTrash size={18} /></button>
            <button class="w-9 h-9 rounded-full border-none bg-transparent cursor-pointer flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--primary)] transition-colors" title={`Mark as spam${getActionShortcutHint("reportSpam")}`} onClick={handleBatchMoveToSpam}><IconSpam size={18} /></button>
            <button class="w-9 h-9 rounded-full border-none bg-transparent cursor-pointer flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--destructive)] transition-colors" title="Block sender(s)" onClick={handleBatchBlockSenders}><IconBlock size={18} /></button>
            <button class="w-9 h-9 rounded-full border-none bg-transparent cursor-pointer flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--primary)] transition-colors" title="Mark as read" onClick={() => handleBatchMarkRead(true)}><IconEnvelopeOpen size={18} /></button>
            <button class="w-9 h-9 rounded-full border-none bg-transparent cursor-pointer flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--hover-bg)] hover:text-[var(--primary)] transition-colors" title={`Mark as unread${getActionShortcutHint("markUnread")}`} onClick={() => handleBatchMarkRead(false)}><IconEnvelope size={18} /></button>
          </div>
          <div class="ml-auto flex items-center gap-1">
            <Show when={isPageTransitionLoading()}>
              <span class="inline-flex items-center gap-1.5 mr-2 text-[12px] text-[var(--text-muted)]">
                <IconRefresh size={12} class="animate-spin" />
                {`Loading page ${pendingPage()}...`}
              </span>
            </Show>
            <span class="text-[13px] text-[var(--text-muted)]">{pageRangeText()}</span>
            <button class="w-8 h-8 rounded-full border-none bg-transparent cursor-pointer flex items-center justify-center text-[var(--text-secondary)] hover:bg-[var(--hover-bg)] disabled:opacity-30" title={`Previous page${getActionShortcutHint("previousPage")}`} onClick={() => goToPage(currentPage() - 1)} disabled={currentPage() <= 1 || isPageTransitionLoading()}><IconChevronLeft size={18} /></button>
            <button class="w-8 h-8 rounded-full border-none bg-transparent cursor-pointer flex items-center justify-center text-[var(--text-secondary)] hover:bg-[var(--hover-bg)] disabled:opacity-30" title={`Next page${getActionShortcutHint("nextPage")}`} onClick={() => goToPage(currentPage() + 1)} disabled={!canGoNextPage() || isPageTransitionLoading()}><IconChevronRight size={18} /></button>
          </div>
        </div>

        <Show when={networkLoadingPage() !== null}>
          <div class="px-4 py-2 border-b border-[var(--border-light)] bg-[var(--hover-bg)] text-[12px] text-[var(--text-muted)] inline-flex items-center gap-2">
            <IconRefresh size={12} class="animate-spin" />
            {`Fetching page ${networkLoadingPage()} from server...`}
          </div>
        </Show>

        {/* Email List */}
        <div class="relative flex-1 min-h-0 flex flex-col">
          <Show when={showListLoadingOverlay()}>
            <div class="absolute inset-0 z-20 bg-[var(--card)]/75 backdrop-blur-[1px] flex items-center justify-center pointer-events-none">
              <div class="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--card)] text-[13px] text-[var(--text-secondary)] shadow-sm">
                <IconRefresh size={14} class="animate-spin" />
                {`Fetching page ${networkLoadingPage() ?? pendingPage() ?? currentPage()}...`}
              </div>
            </div>
          </Show>
          <Show
            when={!paginatedData.loading || paginatedData()}
            fallback={
              <div class="flex-1 p-4 flex flex-col gap-2">
                <div class="text-[12px] text-[var(--text-muted)] inline-flex items-center gap-2">
                  <IconRefresh size={12} class="animate-spin" />
                  {`Loading page ${pendingPage() ?? networkLoadingPage() ?? currentPage()}...`}
                </div>
                <For each={Array(8)}>{() => <div class="skeleton h-11 w-full" />}</For>
              </div>
            }
          >
            <Show when={filteredEmails().length > 0} fallback={
              <div class="flex-1 flex flex-col items-center justify-center py-20 text-center text-[var(--text-muted)]">
                <Show when={labelsState.activeFilter === "starred"} fallback={
                  <IconMail size={48} class="text-[var(--border)] mb-4" strokeWidth={1} />
                }>
                  <IconStar size={48} class="text-[var(--border)] mb-4" strokeWidth={1} />
                </Show>
                <h3 class="text-lg font-semibold text-[var(--text-secondary)] mb-1">
                  {searchTerm()
                    ? "No results found"
                    : labelsState.activeFilter === "starred"
                      ? "No starred emails"
                      : labelsState.activeFilter === IMPORTANT_FILTER_ID
                        ? "No important emails"
                      : labelsState.activeFilter && isCategoryFilterId(labelsState.activeFilter)
                        ? `No emails in ${heading()}`
                      : labelsState.activeFilter
                        ? "No emails with this label"
                        : "Your inbox is empty"}
                </h3>
              </div>
            }>
              <VirtualEmailList
                emails={filteredEmails()}
                selectedEmail={selectedEmail()}
                selectedEmails={selectedEmails()}
                onEmailClick={handleEmailClick}
                onCheckedChange={handleCheckedChange}
                onDelete={handleDeleteFromList}
                onArchive={handleArchiveFromList}
                onStar={handleStar}
                onImportantToggle={handleImportantToggle}
                onLabelAdd={handleLabelAdd}
                onLabelRemove={handleLabelRemove}
                onToggleRead={handleToggleRead}
                onPointerDragStart={handlePointerDragStart}
                onContextMenu={handleContextMenu}
              />
            </Show>
          </Show>
        </div>
      </div>

      {/* Resize Handle */}
      <Show when={showPane() && !isFullSpace()}>
        <div
          class={`relative group shrink-0 transition-colors z-20 ${
            isVertical()
              ? "h-1 w-full cursor-row-resize border-t border-[var(--border-light)] hover:bg-[var(--primary)] hover:h-1.5"
              : "w-1 h-full cursor-col-resize border-l border-[var(--border-light)] hover:bg-[var(--primary)] hover:w-1.5"
          }`}
          onMouseDown={handleMouseDown}
          style={{ "background-color": isResizing() ? "var(--primary)" : undefined }}
        >
          <div class={`absolute ${isVertical() ? "-top-2 -bottom-2 left-0 right-0" : "top-0 bottom-0 -left-2 -right-2"}`} />
        </div>
      </Show>

      {/* Reading Pane */}
      <Show when={!isNone()}>
        <div
          class={`flex-shrink-0 min-w-0 overflow-hidden ${showPane() ? "" : "pointer-events-none"}`}
          aria-hidden={!showPane()}
          style={{
            width: showPane()
              ? (isFullSpace() ? "100%" : (!isVertical() ? `${paneSize()}px` : "100%"))
              : (!isVertical() ? "0px" : "100%"),
            height: showPane()
              ? (isFullSpace() ? "100%" : (isVertical() ? `${paneSize()}px` : "100%"))
              : (isVertical() ? "0px" : "100%"),
            opacity: showPane() ? 1 : 0,
          }}
        >
          <ReadingPane
            emailSeq={selectedEmail()}
            folder={selectedFolder()}
            threadId={selectedThreadId()}
            onClose={handleCloseEmail}
            onDeleted={handleDeletedFromPane}
            onNext={hasNext() ? goToNext : undefined}
            onPrevious={hasPrevious() ? goToPrevious : undefined}
            currentIndex={currentIndex() + 1}
            totalCount={filteredEmails().length}
            isFullSpace={isFullSpace()}
            onToggleFullSpace={() => setFullSpacePane(!fullSpacePane())}
            onBlockSender={handleBlockSender}
            onSnooze={handlePaneSnooze}
            onMoveToSpam={handleMoveToSpamFromPane}
            onToggleRead={handleToggleRead}
          />
        </div>
      </Show>

      {/* Context Menu */}
      <SnoozeMenu
        position={snoozeMenuPosition()}
        onClose={() => {
          setSnoozeMenuPosition(null);
          setPendingSnoozeTargets([]);
        }}
        onSelect={(until) => {
          void handleSnoozeTargets(pendingSnoozeTargets(), until);
        }}
      />
      <Show when={contextMenu()}>
        <ContextMenu
          items={contextMenuItems()}
          x={contextMenu()!.x}
          y={contextMenu()!.y}
          onClose={() => setContextMenu(null)}
        />
      </Show>
      <KeyboardShortcutsHelp open={showKeyboardHelp()} onClose={() => setShowKeyboardHelp(false)} />
    </div>
  );
}
