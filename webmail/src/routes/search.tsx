import { createResource, For, Show, createSignal, createEffect, onMount, onCleanup } from "solid-js";
import { useSearchParams, useNavigate } from "@solidjs/router";
import {
  addEmailLabel,
  archiveEmails,
  deleteEmailsBatch,
  getEmail,
  markAsUnread,
  moveToFolder,
  removeEmailLabel,
  searchEmails,
  toggleStar,
  type EmailMessage,
} from "~/lib/mail-client";
import EmailRow from "~/components/EmailRow";
import ReadingPane from "~/components/ReadingPane";
import { IconSearch, IconRefresh, IconBack } from "~/components/Icons";
import { IMPORTANT_LABEL_NAME } from "~/lib/labels-store";
import { showToast } from "~/lib/toast-store";
import { openCompose, composeState, closeCompose, toggleFullscreen, toggleMinimize, saveComposeDraftNow } from "~/lib/compose-store";
import { formatForwardSubject, formatReplySubject, getForwardQuoteParts, getReplyAllRecipients, getReplyQuoteParts, getReplyRecipients } from "~/lib/reply-utils";
import { SHORTCUT_ACTIONS, getEffectiveActionShortcuts, splitShortcutSteps, formatShortcut, type ShortcutActionId } from "~/lib/keyboard-shortcuts-store";
import { settings } from "~/lib/settings-store";
import KeyboardShortcutsHelp from "~/components/KeyboardShortcutsHelp";

export default function SearchView() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [selectedEmail, setSelectedEmail] = createSignal<EmailMessage | null>(null);
  const [selectedEmails, setSelectedEmails] = createSignal<Set<number>>(new Set());
  const [showKeyboardHelp, setShowKeyboardHelp] = createSignal(false);

  const query = () => {
    const q = searchParams.q;
    return (Array.isArray(q) ? q[0] : q) || "";
  };

  const [results, { refetch }] = createResource(
    () => query(),
    async (q) => {
      if (!q) return [];
      return await searchEmails(q);
    }
  );

  const handleDeletedFromPane = () => {
    setSelectedEmail(null);
    refetch();
  };

  const selectedEmailKey = () => {
    const current = selectedEmail();
    if (!current) return null;
    return `${current.folderPath || "INBOX"}#${current.seq}`;
  };

  const emailKey = (email: Pick<EmailMessage, "seq" | "folderPath">) =>
    `${email.folderPath || "INBOX"}#${email.seq}`;

  const clearSearchAndGoInbox = () => {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("webmail-clear-search-input"));
    }
    navigate("/");
  };

  const isInInput = (target: EventTarget | null): boolean => {
    if (!target || !(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (target.isContentEditable) return true;
    return false;
  };

  const selectByOffset = (offset: 1 | -1) => {
    const list = results() ?? [];
    if (!list.length) return;
    const current = selectedEmail();
    const currentIndex = current
      ? list.findIndex((item) => item.seq === current.seq && (item.folderPath || "INBOX") === (current.folderPath || "INBOX"))
      : -1;
    const nextIndex = currentIndex === -1
      ? (offset > 0 ? 0 : list.length - 1)
      : (currentIndex + offset + list.length) % list.length;
    setSelectedEmail(list[nextIndex] || null);
  };

  const getActionEmails = () => {
    const checked = selectedEmails();
    if (checked.size > 0) {
      return (results() ?? []).filter((email) => checked.has(email.seq));
    }
    const active = selectedEmail();
    return active ? [active] : [];
  };

  const syncSelectionAfterMutation = (fallbackOffset: 1 | -1 = 1) => {
    const list = results() ?? [];
    if (!list.length) {
      setSelectedEmail(null);
      setSelectedEmails(new Set());
      return;
    }
    const current = selectedEmail();
    if (!current) {
      setSelectedEmail(list[0]);
      return;
    }
    const idx = list.findIndex((item) => emailKey(item) === emailKey(current));
    if (idx >= 0) return;
    const nextIndex = fallbackOffset > 0 ? 0 : Math.max(0, list.length - 1);
    setSelectedEmail(list[nextIndex]);
  };

  const runRefresh = async () => {
    await refetch();
    syncSelectionAfterMutation(1);
  };

  const openComposeForSelection = async (mode: "reply" | "reply-all" | "forward") => {
    const active = selectedEmail();
    if (!active) return;
    try {
      const fullEmail = await getEmail(String(active.seq), active.folderPath || "INBOX");
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

  createEffect(() => {
    const list = results() ?? [];
    if (results.loading) return;
    if (!query().trim()) return;
    if (list.length === 0) {
      setSelectedEmail(null);
      setSelectedEmails(new Set());
      return;
    }
    const current = selectedEmail();
    if (!current || !list.some((item) => emailKey(item) === emailKey(current))) {
      setSelectedEmail(list[0]);
    }
  });

  onMount(() => {
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
        if (REVERSE_SHIFTED_ALIASES[key]) addCandidate(candidates, key, { ...mods, shift: false });
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
        setSelectedEmail(null);
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
        void saveComposeDraftNow().then((saved) => {
          showToast(saved ? "Draft saved" : "Nothing to save", saved ? "success" : "info");
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
        void runRefresh();
        return true;
      }
      if (actionId === "nextConversation") {
        selectByOffset(1);
        return true;
      }
      if (actionId === "previousConversation") {
        selectByOffset(-1);
        return true;
      }
      if (actionId === "openConversation") {
        const active = selectedEmail();
        if (!active) return false;
        navigate(`/email/${active.seq}?folder=${encodeURIComponent(active.folderPath || "INBOX")}`);
        return true;
      }
      if (actionId === "returnToList") {
        setSelectedEmail(null);
        return true;
      }
      if (actionId === "archiveConversation") {
        const targets = getActionEmails();
        if (!targets.length) return false;
        void (async () => {
          const buckets = new Map<string, string[]>();
          for (const item of targets) {
            const folder = item.folderPath || "INBOX";
            const seqs = buckets.get(folder) || [];
            seqs.push(String(item.seq));
            buckets.set(folder, seqs);
          }
          for (const [folder, seqs] of buckets) {
            await archiveEmails(seqs, folder);
          }
          await runRefresh();
        })();
        return true;
      }
      if (actionId === "deleteConversation") {
        const targets = getActionEmails();
        if (!targets.length) return false;
        void (async () => {
          const buckets = new Map<string, string[]>();
          for (const item of targets) {
            const folder = item.folderPath || "INBOX";
            const seqs = buckets.get(folder) || [];
            seqs.push(String(item.seq));
            buckets.set(folder, seqs);
          }
          for (const [folder, seqs] of buckets) {
            await deleteEmailsBatch(seqs, folder);
          }
          await runRefresh();
        })();
        return true;
      }
      if (actionId === "toggleStar") {
        const active = selectedEmail();
        if (!active) return false;
        const isStarred = (active.flags || []).includes("\\Flagged");
        void toggleStar(String(active.seq), !isStarred, active.folderPath || "INBOX").then(() => runRefresh());
        return true;
      }
      if (actionId === "toggleSelection") {
        const active = selectedEmail();
        if (!active) return false;
        setSelectedEmails((prev) => {
          const next = new Set(prev);
          if (next.has(active.seq)) next.delete(active.seq);
          else next.add(active.seq);
          return next;
        });
        return true;
      }
      if (actionId === "markUnread") {
        const targets = getActionEmails();
        if (!targets.length) return false;
        void Promise.all(targets.map((item) => markAsUnread(String(item.seq), item.folderPath || "INBOX"))).then(() => runRefresh());
        return true;
      }
      if (actionId === "markImportant") {
        const active = selectedEmail();
        if (!active) return false;
        const isImportant = (active.flags || []).includes(IMPORTANT_LABEL_NAME);
        const fn = isImportant ? removeEmailLabel : addEmailLabel;
        void fn(String(active.seq), IMPORTANT_LABEL_NAME, active.folderPath || "INBOX").then(() => runRefresh());
        return true;
      }
      if (actionId === "reportSpam") {
        const targets = getActionEmails();
        if (!targets.length) return false;
        void Promise.all(targets.map((item) => moveToFolder(String(item.seq), item.folderPath || "INBOX", "Spam"))).then(() => runRefresh());
        return true;
      }
      if (actionId === "archivePrevious") {
        const active = selectedEmail();
        if (!active) return false;
        void archiveEmails([String(active.seq)], active.folderPath || "INBOX").then(async () => {
          await refetch();
          syncSelectionAfterMutation(-1);
        });
        return true;
      }
      if (actionId === "archiveNext") {
        const active = selectedEmail();
        if (!active) return false;
        void archiveEmails([String(active.seq)], active.folderPath || "INBOX").then(async () => {
          await refetch();
          syncSelectionAfterMutation(1);
        });
        return true;
      }
      if (actionId === "reply") {
        void openComposeForSelection("reply");
        return true;
      }
      if (actionId === "replyAll") {
        void openComposeForSelection("reply-all");
        return true;
      }
      if (actionId === "forward") {
        void openComposeForSelection("forward");
        return true;
      }
      if (actionId === "gotoInbox") {
        clearSearchAndGoInbox();
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
      if (e.key === "Escape" && showKeyboardHelp()) {
        setShowKeyboardHelp(false);
        return;
      }

      const candidates = eventStepCandidates(e);
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

      if (e.key === "ArrowDown") {
        e.preventDefault();
        selectByOffset(1);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        selectByOffset(-1);
        return;
      }
      if (e.key === "Backspace") {
        e.preventDefault();
        clearSearchAndGoInbox();
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
        chordTimer = setTimeout(() => {
          pendingChordStep = null;
        }, 800);
      }
    };
    const handleSearchExitFocus = () => {
      const first = (results() ?? [])[0];
      if (first) setSelectedEmail(first);
    };
    document.addEventListener("keydown", handleKeyDown);
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

  return (
    <div class="flex flex-1 h-full overflow-hidden">
      {/* Results Panel */}
      <div
        class={`flex flex-col overflow-hidden transition-all duration-200 ${
          selectedEmail() !== null ? "w-[520px] min-w-[400px] shrink-0 border-r border-[var(--border-light)]" : "flex-1"
        }`}
      >
        {/* Search Header */}
        <div class="flex items-center gap-3 px-6 py-4 border-b border-[var(--border-light)] bg-[var(--card)] shrink-0">
          <button
            onClick={clearSearchAndGoInbox}
            class="w-9 h-9 rounded-full border-none bg-transparent cursor-pointer flex items-center justify-center text-[var(--text-secondary)] transition-colors hover:bg-[var(--hover-bg)]"
            title="Back to Inbox"
          >
            <IconBack size={18} />
          </button>
          <div class="flex items-center gap-2">
            <IconSearch size={20} class="text-[var(--primary)]" />
            <h1 class="text-lg font-semibold text-[var(--foreground)]">
              Results for "{query()}"
            </h1>
          </div>
          <button
            onClick={() => refetch()}
            class="w-9 h-9 rounded-full border-none bg-transparent cursor-pointer flex items-center justify-center text-[var(--text-secondary)] transition-colors hover:bg-[var(--hover-bg)] ml-auto"
            title="Refresh"
          >
            <IconRefresh size={18} />
          </button>
        </div>

        {/* Results count */}
        <div class="px-6 py-2 border-b border-[var(--border-light)] bg-[var(--card)] shrink-0">
          <span class="text-[13px] text-[var(--text-muted)]">
            {results.loading ? "Searching..." : `${results()?.length ?? 0} results`}
          </span>
        </div>

        {/* Results List */}
        <div class="flex-1 overflow-y-auto">
          <Show
            when={!results.loading}
            fallback={
              <div class="p-4 flex flex-col gap-1">
                <For each={Array(5)}>{() => <div class="skeleton h-11 w-full" />}</For>
              </div>
            }
          >
            <For each={results() ?? []}>
              {(email) => (
                <EmailRow
                  email={email}
                  active={selectedEmailKey() === `${email.folderPath || "INBOX"}#${email.seq}`}
                  checked={selectedEmails().has(email.seq)}
                  onCheckedChange={(seq, checked) => {
                    setSelectedEmails((prev) => {
                      const next = new Set(prev);
                      if (checked) next.add(seq);
                      else next.delete(seq);
                      return next;
                    });
                  }}
                  onStar={(seq, starred) => {
                    void toggleStar(String(seq), starred, email.folderPath || "INBOX").then(() => runRefresh());
                  }}
                  onImportantToggle={(seq, important) => {
                    const fn = important ? addEmailLabel : removeEmailLabel;
                    void fn(String(seq), IMPORTANT_LABEL_NAME, email.folderPath || "INBOX").then(() => runRefresh());
                  }}
                  onClick={() => setSelectedEmail(email)}
                />
              )}
            </For>

            <Show when={(results()?.length ?? 0) === 0}>
              <div class="flex flex-col items-center justify-center py-20 text-center text-[var(--text-muted)]">
                <IconSearch size={48} class="text-[var(--border)] mb-4" strokeWidth={1} />
                <h3 class="text-lg font-semibold text-[var(--text-secondary)] mb-1">
                  No results found
                </h3>
                <p class="text-sm">
                  Try different search terms
                </p>
              </div>
            </Show>
          </Show>
        </div>
      </div>

      {/* Reading Pane */}
      <Show when={selectedEmail()}>
        <div class="flex-1 min-w-0 overflow-hidden">
          <ReadingPane
            emailSeq={selectedEmail()!.seq}
            folder={selectedEmail()!.folderPath || "INBOX"}
            onClose={() => setSelectedEmail(null)}
            onDeleted={handleDeletedFromPane}
          />
        </div>
      </Show>

      <KeyboardShortcutsHelp
        open={showKeyboardHelp()}
        onClose={() => setShowKeyboardHelp(false)}
      />
    </div>
  );
}
