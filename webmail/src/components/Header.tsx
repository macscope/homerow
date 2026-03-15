import { createSignal, onCleanup, onMount, Show, type Accessor, type Setter } from "solid-js";
import { useNavigate } from "@solidjs/router";
import { IconSearch, IconSettings, IconChevronLeft, IconChevronRight, IconChevronDown, IconSlidersHorizontal, IconClose, IconGithub } from "./Icons";
import { authClient } from "~/lib/auth-client";
import { toggleCommandPalette } from "~/lib/command-palette-store";
import { formatShortcut, getActionShortcutHint, getPreferredActionShortcut } from "~/lib/keyboard-shortcuts-store";
import type { UpdateStatusPayload } from "~/lib/update-status-types";

interface HeaderProps {
  searchTerm: Accessor<string>;
  setSearchTerm: Setter<string>;
  onSearch?: (query: string) => void;
  onOpenSettings: () => void;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  hasUpdateAvailable?: boolean;
  updateStatus?: UpdateStatusPayload;
}

export default function Header(props: HeaderProps) {
  const navigate = useNavigate();
  const session = authClient.useSession();
  const [isUserMenuOpen, setIsUserMenuOpen] = createSignal(false);
  const [isGithubMenuOpen, setIsGithubMenuOpen] = createSignal(false);
  const [isSearchFiltersOpen, setIsSearchFiltersOpen] = createSignal(false);
  const [fromFilter, setFromFilter] = createSignal("");
  const [toFilter, setToFilter] = createSignal("");
  const [subjectFilter, setSubjectFilter] = createSignal("");
  const [includesWords, setIncludesWords] = createSignal("");
  const [withoutWords, setWithoutWords] = createSignal("");
  const [sizeOp, setSizeOp] = createSignal<"none" | "larger" | "smaller">("none");
  const [sizeValue, setSizeValue] = createSignal("");
  const [sizeUnit, setSizeUnit] = createSignal<"KB" | "MB" | "GB">("MB");
  const [dateWithin, setDateWithin] = createSignal<"none" | "1d" | "7d" | "30d" | "365d">("none");
  const [afterDate, setAfterDate] = createSignal("");
  const [beforeDate, setBeforeDate] = createSignal("");
  const [mailbox, setMailbox] = createSignal("allmail");
  const [hasAttachment, setHasAttachment] = createSignal(false);
  const [isUnread, setIsUnread] = createSignal(false);
  const [isStarred, setIsStarred] = createSignal(false);

  let userMenuRef: HTMLDivElement | undefined;
  let userMenuButtonRef: HTMLButtonElement | undefined;
  let githubMenuRef: HTMLDivElement | undefined;
  let githubMenuButtonRef: HTMLButtonElement | undefined;
  let searchFiltersRef: HTMLDivElement | undefined;
  let searchFiltersButtonRef: HTMLButtonElement | undefined;

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      props.onSearch?.(props.searchTerm());
      return;
    }
    if (e.key === "Backspace" && !props.searchTerm().trim()) {
      e.preventDefault();
      props.setSearchTerm("");
      navigate("/");
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      (e.currentTarget as HTMLInputElement | undefined)?.blur();
      setIsSearchFiltersOpen(false);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("webmail-search-exit-focus-results"));
      }
    }
  };

  const buildAdvancedQuery = () => {
    const parts: string[] = [];
    const pushQuoted = (key: string, value: string) => {
      const cleaned = value.trim();
      if (!cleaned) return;
      parts.push(`${key}:"${cleaned.replaceAll('"', '\\"')}"`);
    };

    pushQuoted("from", fromFilter());
    pushQuoted("to", toFilter());
    pushQuoted("subject", subjectFilter());
    pushQuoted("includes", includesWords());
    pushQuoted("without", withoutWords());

    if (sizeOp() !== "none" && sizeValue().trim()) {
      const raw = Number(sizeValue());
      if (Number.isFinite(raw) && raw > 0) parts.push(`${sizeOp()}:${raw}${sizeUnit().toLowerCase()}`);
    }
    if (dateWithin() === "1d") parts.push("newer_than:1d");
    if (dateWithin() === "7d") parts.push("newer_than:7d");
    if (dateWithin() === "30d") parts.push("newer_than:30d");
    if (dateWithin() === "365d") parts.push("newer_than:365d");

    if (afterDate()) parts.push(`after:${afterDate()}`);
    if (beforeDate()) parts.push(`before:${beforeDate()}`);
    if (mailbox() !== "allmail") parts.push(`in:${mailbox()}`);
    if (hasAttachment()) parts.push("has:attachment");
    if (isUnread()) parts.push("is:unread");
    if (isStarred()) parts.push("is:starred");

    return parts.join(" ").trim();
  };

  const applyAdvancedSearch = () => {
    const built = buildAdvancedQuery();
    const query = built || props.searchTerm().trim();
    if (!query) return;
    props.setSearchTerm(query);
    props.onSearch?.(query);
    setIsSearchFiltersOpen(false);
  };

  const clearAdvancedFilters = () => {
    setFromFilter("");
    setToFilter("");
    setSubjectFilter("");
    setIncludesWords("");
    setWithoutWords("");
    setSizeOp("none");
    setSizeValue("");
    setSizeUnit("MB");
    setDateWithin("none");
    setAfterDate("");
    setBeforeDate("");
    setMailbox("allmail");
    setHasAttachment(false);
    setIsUnread(false);
    setIsStarred(false);
  };

  const userEmail = () => session().data?.user?.email || "";
  const userInitial = () => userEmail().slice(0, 1).toUpperCase() || "U";
  const userAvatarImage = () => session().data?.user?.image || "";
  const commandPaletteShortcutLabel = () => {
    const shortcut = getPreferredActionShortcut("openCommandPalette");
    return shortcut ? formatShortcut(shortcut) : "Set shortcut";
  };

  const handleSignOut = async () => {
    setIsUserMenuOpen(false);
    try {
      await authClient.signOut();
    } finally {
      if (typeof window !== "undefined") {
        window.location.replace("/login");
      } else {
        navigate("/login");
      }
    }
  };

  const toggleUserMenu = () => {
    setIsUserMenuOpen((open) => !open);
  };

  const closeUserMenu = () => {
    setIsUserMenuOpen(false);
  };

  const closeGithubMenu = () => {
    setIsGithubMenuOpen(false);
  };

  const closeSearchFilters = () => {
    setIsSearchFiltersOpen(false);
  };

  onMount(() => {
    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (userMenuRef?.contains(target)) return;
      if (userMenuButtonRef?.contains(target)) return;
      closeUserMenu();
      if (githubMenuRef?.contains(target)) return;
      if (githubMenuButtonRef?.contains(target)) return;
      closeGithubMenu();
      if (searchFiltersRef?.contains(target)) return;
      if (searchFiltersButtonRef?.contains(target)) return;
      closeSearchFilters();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeUserMenu();
        closeGithubMenu();
        closeSearchFilters();
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    onCleanup(() => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    });
  });

  return (
    <header class="col-span-full flex items-center px-4 py-2 min-h-[68px] bg-[var(--card)] border-b border-[var(--border-light)] shadow-[0_1px_2px_rgba(0,0,0,0.04)] z-10 gap-4">
      {/* Logo */}
      <div class="flex items-center gap-2 w-[214px] shrink-0">
        <button
          class="w-9 h-9 rounded-full border-none bg-transparent cursor-pointer flex items-center justify-center text-[var(--text-secondary)] transition-colors duration-200 hover:bg-[var(--hover-bg)] hover:text-[var(--foreground)]"
          title={`${props.sidebarCollapsed ? "Expand menu" : "Collapse menu"}${getActionShortcutHint("openLeftMenu")}`}
          onClick={props.onToggleSidebar}
        >
          {props.sidebarCollapsed ? <IconChevronRight size={18} /> : <IconChevronLeft size={18} />}
        </button>
        <button
          class="relative flex items-center gap-2.5 border-none bg-transparent rounded-xl px-1.5 py-1 cursor-pointer text-left text-[var(--foreground)] hover:bg-[var(--hover-bg)] transition-colors"
          title={`Go to Inbox${getActionShortcutHint("gotoInbox")}`}
          aria-label="Go to Inbox"
          onClick={() => {
            navigate("/");
          }}
        >
          <img src="/logo.svg" alt="" aria-hidden="true" class="h-8 w-auto max-w-[40px] object-contain shrink-0" />
          <div class="flex flex-col leading-none">
            <span class="text-[9px] font-medium uppercase tracking-[0.08em] text-[var(--text-muted)] opacity-75">Homerow</span>
            <span class="inline-flex items-baseline gap-1 text-xl font-semibold tracking-tight text-[var(--foreground)]">
              <span>Mail</span>
              <span class="text-[9px] font-normal text-[var(--text-muted)] opacity-75">beta</span>
            </span>
          </div>
        </button>
      </div>

      {/* Search */}
      <div class="flex-1 max-w-[760px] relative">
        <div class="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--text-secondary)] pointer-events-none">
          <IconSearch size={18} />
        </div>
        <input
          type="text"
          placeholder="Search messages"
          value={props.searchTerm()}
          onInput={(e) => props.setSearchTerm(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
          class="w-full h-[52px] pl-12 pr-20 border-none rounded-full bg-[var(--search-bg)] text-[15px] text-[var(--foreground)] outline-none transition-all duration-200 focus:bg-[var(--card)] focus:shadow-[0_1px_4px_rgba(0,0,0,0.1)] placeholder:text-[var(--text-muted)]"
        />
        <button
          ref={searchFiltersButtonRef}
          class={`absolute right-11 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full border-none bg-transparent cursor-pointer flex items-center justify-center transition-colors ${
            isSearchFiltersOpen()
              ? "text-[var(--primary)] bg-[var(--active-bg)]"
              : "text-[var(--text-secondary)] hover:bg-[var(--hover-bg)] hover:text-[var(--foreground)]"
          }`}
          title="Show search options"
          onClick={() => setIsSearchFiltersOpen((open) => !open)}
        >
          <IconSlidersHorizontal size={16} />
        </button>
        <button
          class="absolute right-3 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full border-none bg-transparent cursor-pointer flex items-center justify-center text-[var(--text-secondary)] transition-colors hover:bg-[var(--hover-bg)] hover:text-[var(--foreground)]"
          title={`Search${getActionShortcutHint("focusSearch")}`}
          onClick={() => props.onSearch?.(props.searchTerm())}
        >
          <IconSearch size={16} />
        </button>

        <Show when={isSearchFiltersOpen()}>
          <div
            ref={searchFiltersRef}
            class="absolute right-0 top-[calc(100%+8px)] w-[min(760px,calc(100vw-2rem))] rounded-xl border border-[var(--border-light)] bg-[var(--card)] shadow-xl p-5 z-40"
          >
            <div class="flex items-center justify-between gap-2 pb-3">
              <div class="text-sm font-medium text-[var(--text-secondary)]">Search options</div>
              <button
                class="w-8 h-8 rounded-full border-none bg-transparent cursor-pointer flex items-center justify-center text-[var(--text-secondary)] hover:bg-[var(--hover-bg)] hover:text-[var(--foreground)]"
                title="Close search options"
                onClick={closeSearchFilters}
              >
                <IconClose size={14} />
              </button>
            </div>

            <div class="flex flex-col gap-3">
              <div class="flex flex-col md:flex-row md:items-center gap-2">
                <label class="w-[120px] text-sm text-[var(--text-secondary)]">From</label>
                <input value={fromFilter()} onInput={(e) => setFromFilter(e.currentTarget.value)} placeholder="sender@example.com" class="h-9 flex-1 px-3 border border-[var(--border)] rounded-lg bg-transparent text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)]" />
              </div>

              <div class="flex flex-col md:flex-row md:items-center gap-2">
                <label class="w-[120px] text-sm text-[var(--text-secondary)]">To</label>
                <input value={toFilter()} onInput={(e) => setToFilter(e.currentTarget.value)} placeholder="recipient@example.com" class="h-9 flex-1 px-3 border border-[var(--border)] rounded-lg bg-transparent text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)]" />
              </div>

              <div class="flex flex-col md:flex-row md:items-center gap-2">
                <label class="w-[120px] text-sm text-[var(--text-secondary)]">Subject</label>
                <input value={subjectFilter()} onInput={(e) => setSubjectFilter(e.currentTarget.value)} placeholder="Subject contains..." class="h-9 flex-1 px-3 border border-[var(--border)] rounded-lg bg-transparent text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)]" />
              </div>

              <div class="flex flex-col md:flex-row md:items-center gap-2">
                <label class="w-[120px] text-sm text-[var(--text-secondary)]">Includes</label>
                <input value={includesWords()} onInput={(e) => setIncludesWords(e.currentTarget.value)} placeholder="Words to include" class="h-9 flex-1 px-3 border border-[var(--border)] rounded-lg bg-transparent text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)]" />
              </div>

              <div class="flex flex-col md:flex-row md:items-center gap-2">
                <label class="w-[120px] text-sm text-[var(--text-secondary)]">Doesn't have</label>
                <input value={withoutWords()} onInput={(e) => setWithoutWords(e.currentTarget.value)} placeholder="Words to exclude" class="h-9 flex-1 px-3 border border-[var(--border)] rounded-lg bg-transparent text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)]" />
              </div>

              <div class="flex flex-col md:flex-row md:items-center gap-2">
                <label class="w-[120px] text-sm text-[var(--text-secondary)]">Size</label>
                <div class="flex flex-1 gap-2">
                  <select value={sizeOp()} onChange={(e) => setSizeOp(e.currentTarget.value as "none" | "larger" | "smaller")} class="h-9 px-3 border border-[var(--border)] rounded-lg bg-transparent text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)]">
                    <option value="none">Any size</option>
                    <option value="larger">Greater than</option>
                    <option value="smaller">Less than</option>
                  </select>
                  <input type="number" min="0" step="1" value={sizeValue()} onInput={(e) => setSizeValue(e.currentTarget.value)} placeholder="Value" class="h-9 w-28 px-3 border border-[var(--border)] rounded-lg bg-transparent text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)]" />
                  <select value={sizeUnit()} onChange={(e) => setSizeUnit(e.currentTarget.value as "KB" | "MB" | "GB")} class="h-9 px-3 border border-[var(--border)] rounded-lg bg-transparent text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)]">
                    <option value="KB">KB</option>
                    <option value="MB">MB</option>
                    <option value="GB">GB</option>
                  </select>
                </div>
              </div>

              <div class="flex flex-col md:flex-row md:items-center gap-2">
                <label class="w-[120px] text-sm text-[var(--text-secondary)]">Date within</label>
                <div class="flex flex-1 gap-2">
                  <select value={dateWithin()} onChange={(e) => setDateWithin(e.currentTarget.value as "none" | "1d" | "7d" | "30d" | "365d")} class="h-9 px-3 border border-[var(--border)] rounded-lg bg-transparent text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)]">
                    <option value="none">Any time</option>
                    <option value="1d">1 day</option>
                    <option value="7d">7 days</option>
                    <option value="30d">30 days</option>
                    <option value="365d">1 year</option>
                  </select>
                  <input type="date" value={afterDate()} onInput={(e) => setAfterDate(e.currentTarget.value)} class="h-9 px-3 border border-[var(--border)] rounded-lg bg-transparent text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)]" />
                  <input type="date" value={beforeDate()} onInput={(e) => setBeforeDate(e.currentTarget.value)} class="h-9 px-3 border border-[var(--border)] rounded-lg bg-transparent text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)]" />
                </div>
              </div>

              <div class="flex flex-col md:flex-row md:items-center gap-2">
                <label class="w-[120px] text-sm text-[var(--text-secondary)]">Search</label>
                <select value={mailbox()} onChange={(e) => setMailbox(e.currentTarget.value)} class="h-9 min-w-[220px] px-3 border border-[var(--border)] rounded-lg bg-transparent text-sm text-[var(--foreground)] outline-none focus:border-[var(--primary)]">
                  <option value="allmail">All Mail</option>
                  <option value="inbox">Inbox</option>
                  <option value="sent">Sent</option>
                  <option value="drafts">Drafts</option>
                  <option value="archive">Archive</option>
                  <option value="trash">Trash</option>
                  <option value="spam">Spam</option>
                </select>
              </div>
            </div>

            <div class="flex flex-wrap items-center gap-5 pt-4">
              <label class="inline-flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                <input type="checkbox" checked={hasAttachment()} onChange={(e) => setHasAttachment(e.currentTarget.checked)} />
                Has attachment
              </label>
              <label class="inline-flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                <input type="checkbox" checked={isUnread()} onChange={(e) => setIsUnread(e.currentTarget.checked)} />
                Unread
              </label>
              <label class="inline-flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                <input type="checkbox" checked={isStarred()} onChange={(e) => setIsStarred(e.currentTarget.checked)} />
                Starred
              </label>
            </div>

            <div class="flex items-center justify-between gap-2 pt-5">
              <button
                class="h-9 px-3 rounded-lg border border-[var(--border)] bg-transparent text-sm text-[var(--text-secondary)] cursor-pointer hover:bg-[var(--hover-bg)]"
                onClick={clearAdvancedFilters}
              >
                Reset
              </button>
              <div class="flex items-center gap-2">
                <button
                  class="h-9 px-4 rounded-lg border border-[var(--border)] bg-transparent text-sm text-[var(--text-secondary)] cursor-pointer hover:bg-[var(--hover-bg)]"
                  onClick={applyAdvancedSearch}
                >
                  Create filter
                </button>
                <button
                  class="h-9 px-4 rounded-full border-none bg-[var(--primary)] text-[var(--primary-foreground)] text-sm font-medium cursor-pointer"
                  onClick={applyAdvancedSearch}
                >
                  Search
                </button>
              </div>
            </div>
          </div>
        </Show>
      </div>

      {/* Actions */}
      <div class="flex items-center gap-1.5 ml-auto">
        <button
          class="hidden md:inline-flex h-10 items-center gap-2 rounded-full border border-[var(--border)] bg-transparent px-3 text-xs text-[var(--text-secondary)] cursor-pointer transition-colors duration-200 hover:bg-[var(--hover-bg)] hover:text-[var(--foreground)]"
          title={`Open command palette${getActionShortcutHint("openCommandPalette")}`}
          aria-label="Open command palette"
          data-testid="command-palette-indicator"
          onClick={toggleCommandPalette}
        >
          <span class="uppercase tracking-[0.08em] text-[10px]">Command</span>
          <span class="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--search-bg)] px-1.5 py-0.5 leading-none text-[11px] text-[var(--text-muted)]">
            <span>{commandPaletteShortcutLabel()}</span>
          </span>
        </button>
        <div class="relative">
          <button
            ref={githubMenuButtonRef}
            data-testid="github-menu-button"
            class="relative w-10 h-10 rounded-full border-none bg-transparent cursor-pointer flex items-center justify-center text-[var(--text-secondary)] transition-colors duration-200 hover:bg-[var(--hover-bg)] hover:text-[var(--foreground)]"
            title="Open Homerow links"
            aria-label="Open Homerow links"
            aria-haspopup="menu"
            aria-expanded={isGithubMenuOpen()}
            onClick={() => setIsGithubMenuOpen((open) => !open)}
          >
            <IconGithub size={19} />
            <Show when={props.hasUpdateAvailable}>
              <span
                data-testid="github-menu-update-dot"
                class="absolute right-1.5 top-1.5 h-2.5 w-2.5 rounded-full bg-[#f59e0b] border border-[var(--card)]"
                aria-label="Update available"
              />
            </Show>
          </button>
          <Show when={isGithubMenuOpen()}>
            <div
              ref={githubMenuRef}
              class="absolute right-0 top-[calc(100%+8px)] w-[260px] rounded-xl border border-[var(--border-light)] bg-[var(--card)] shadow-xl py-1 z-30"
              role="menu"
              aria-label="Homerow links menu"
            >
              <Show when={props.hasUpdateAvailable}>
                <button
                  data-testid="github-menu-update-item"
                  class="w-full text-left px-3 py-2.5 text-sm border-none bg-transparent cursor-pointer text-[var(--foreground)] hover:bg-[var(--hover-bg)] transition-colors"
                  role="menuitem"
                  onClick={() => {
                    closeGithubMenu();
                    navigate("/settings?tab=general");
                  }}
                >
                  {`Update available (${props.updateStatus?.installed ?? "current"} -> ${props.updateStatus?.latest ?? "latest"})`}
                </button>
              </Show>
              <a
                href={props.updateStatus?.releaseUrl || "https://github.com/guilhermeprokisch/homerow/releases"}
                target="_blank"
                rel="noreferrer"
                class="block px-3 py-2.5 text-sm text-[var(--foreground)] no-underline hover:bg-[var(--hover-bg)] transition-colors"
                role="menuitem"
                onClick={closeGithubMenu}
              >
                Updates & announcements
              </a>
              <a
                href="https://github.com/guilhermeprokisch/homerow/issues/new/choose"
                target="_blank"
                rel="noreferrer"
                class="block px-3 py-2.5 text-sm text-[var(--foreground)] no-underline hover:bg-[var(--hover-bg)] transition-colors"
                role="menuitem"
                onClick={closeGithubMenu}
              >
                Report a bug
              </a>
              <a
                href="https://github.com/guilhermeprokisch/homerow/stargazers"
                target="_blank"
                rel="noreferrer"
                class="block px-3 py-2.5 text-sm text-[var(--foreground)] no-underline hover:bg-[var(--hover-bg)] transition-colors"
                role="menuitem"
                onClick={closeGithubMenu}
              >
                Give a star
              </a>
            </div>
          </Show>
        </div>
        <button
          class="w-10 h-10 rounded-full border-none bg-transparent cursor-pointer flex items-center justify-center text-[var(--text-secondary)] transition-colors duration-200 hover:bg-[var(--hover-bg)] hover:text-[var(--foreground)]"
          title={`Settings${getActionShortcutHint("openRightMenu")}`}
          onClick={props.onOpenSettings}
        >
          <IconSettings size={20} />
        </button>
        <div class="relative ml-2">
          <button
            ref={userMenuButtonRef}
            class="h-9 rounded-full bg-transparent border-none cursor-pointer flex items-center gap-1 pr-1 pl-0.5 text-[var(--text-secondary)] hover:bg-[var(--hover-bg)] transition-colors"
            title={userEmail() ? `Account menu (${userEmail()})` : "Account menu"}
            aria-label="Open account menu"
            aria-haspopup="menu"
            aria-expanded={isUserMenuOpen()}
            onClick={toggleUserMenu}
          >
            <span class="w-9 h-9 rounded-full bg-gradient-to-br from-[var(--primary)] to-[#0ea5e9] text-white flex items-center justify-center font-bold text-sm shadow-sm border-2 border-[var(--card)] box-content border-solid">
              <Show
                when={userAvatarImage()}
                fallback={userInitial()}
              >
                <img
                  src={userAvatarImage()!}
                  alt="Profile avatar"
                  class="w-full h-full rounded-full object-cover"
                />
              </Show>
            </span>
            <IconChevronDown size={14} />
          </button>

          <Show when={isUserMenuOpen()}>
            <div
              ref={userMenuRef}
              class="absolute right-0 top-[calc(100%+8px)] w-[220px] rounded-xl border border-[var(--border-light)] bg-[var(--card)] shadow-xl py-1 z-30"
              role="menu"
              aria-label="Account menu"
            >
              <div class="px-3 py-2 border-b border-[var(--border-light)]">
                <div class="text-xs text-[var(--text-muted)]">Signed in as</div>
                <div class="text-sm text-[var(--foreground)] truncate">{userEmail() || "Unknown user"}</div>
              </div>
              <button
                class="w-full text-left px-3 py-2.5 text-sm border-none bg-transparent cursor-pointer text-[var(--foreground)] hover:bg-[var(--hover-bg)] transition-colors"
                role="menuitem"
                onClick={() => {
                  closeUserMenu();
                  navigate("/settings?tab=accounts");
                }}
              >
                Profile & account
              </button>
              <button
                class="w-full text-left px-3 py-2.5 text-sm border-none bg-transparent cursor-pointer text-[var(--destructive)] hover:bg-[var(--hover-bg)] transition-colors"
                role="menuitem"
                onClick={handleSignOut}
              >
                Log off
              </button>
            </div>
          </Show>
        </div>
      </div>
    </header>
  );
}
