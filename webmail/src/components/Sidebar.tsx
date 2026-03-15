// src/components/Sidebar.tsx
import { A, useLocation } from "@solidjs/router";
import { For, createResource, createEffect, Show, createSignal, onCleanup, createMemo } from "solid-js";
import { openCompose } from "~/lib/compose-store";
import { labelsState, setActiveFilter, IMPORTANT_FILTER_ID, getVisibleLabels, isCategoryFilterId, getCategoryTabs, PRIMARY_CATEGORY_KEY, type CategoryIconId } from "~/lib/labels-store";
import { settings, DENSITY_CONFIG } from "~/lib/settings-store";
import { getFolderCounts } from "~/lib/mail-client";
import { triggerUpdate, refreshCounts, publishFolderCounts } from "~/lib/sidebar-store";
import { useMailEvents, requestNotificationPermission } from "~/lib/mail-events";
import { IconInbox, IconSend, IconSendClock, IconTrash, IconCompose, IconArchive, IconSpam, IconLabel, IconStar, IconSettings, IconDrafts, IconUsers, IconImportant, IconChevronDown, IconChevronRight, IconInfo, IconSparkles, IconBriefcase, IconCart, IconReceipt, IconHeart, IconCode, IconBolt, IconClock } from "./Icons";
import LabelModal from "./LabelModal";

export default function Sidebar() {
  const SIDEBAR_CATEGORIES_EXPANDED_KEY = "sidebarCategoriesExpanded";
  const SIDEBAR_SENT_EXPANDED_KEY = "sidebarSentExpanded";
  const location = useLocation();
  const [showLabelModal, setShowLabelModal] = createSignal(false);
  const [categoriesExpanded, setCategoriesExpanded] = createSignal(true);
  const [sentExpanded, setSentExpanded] = createSignal(true);
  const [isImportActive, setIsImportActive] = createSignal(false);
  const [stableCounts, setStableCounts] = createSignal<Record<string, { unread: number; total: number }>>({});
  const [treeStateHydrated, setTreeStateHydrated] = createSignal(false);
  let refreshDebounce: ReturnType<typeof setTimeout> | undefined;
  let lastRefreshAt = 0;
  const density = () => DENSITY_CONFIG[settings.density];

  // Real-time count updates via SSE
  const { trigger: mailEventTrigger } = useMailEvents();

  createEffect(() => {
    const t = mailEventTrigger();
    if (t === 0) return;
    if (isImportActive()) return;
    const now = Date.now();
    if (now - lastRefreshAt < 1500) {
      if (!refreshDebounce) {
        refreshDebounce = setTimeout(() => {
          refreshDebounce = undefined;
          lastRefreshAt = Date.now();
          refreshCounts();
        }, 1500 - (now - lastRefreshAt));
      }
      return;
    }
    lastRefreshAt = now;
    refreshCounts();
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    if (treeStateHydrated()) return;
    const storedCategories = localStorage.getItem(SIDEBAR_CATEGORIES_EXPANDED_KEY);
    if (storedCategories === "true" || storedCategories === "false") {
      setCategoriesExpanded(storedCategories === "true");
    }
    const storedSent = localStorage.getItem(SIDEBAR_SENT_EXPANDED_KEY);
    if (storedSent === "true" || storedSent === "false") {
      setSentExpanded(storedSent === "true");
    }
    setTreeStateHydrated(true);
  });

  createEffect(() => {
    if (typeof window === "undefined" || !treeStateHydrated()) return;
    localStorage.setItem(SIDEBAR_CATEGORIES_EXPANDED_KEY, categoriesExpanded() ? "true" : "false");
  });

  createEffect(() => {
    if (typeof window === "undefined" || !treeStateHydrated()) return;
    localStorage.setItem(SIDEBAR_SENT_EXPANDED_KEY, sentExpanded() ? "true" : "false");
  });

  createEffect(() => {
    if (typeof window === "undefined") return;
    const updateImportState = () => setIsImportActive(localStorage.getItem("takeoutImportActive") === "true");
    updateImportState();
    const timer = setInterval(updateImportState, 2000);
    onCleanup(() => clearInterval(timer));
  });

  createEffect(() => {
    if (!isImportActive()) {
      refreshCounts();
    }
  });

  // Auto-request notification permission when setting is enabled
  createEffect(() => {
    if (settings.notifications) {
      requestNotificationPermission();
    }
  });

  const [counts] = createResource(triggerUpdate, async () => {
    return await getFolderCounts(["Inbox", "Starred", "Important", "Drafts", "Sent", "Scheduled", "Archive", "Snoozed", "Trash", "Spam"]);
  }, { initialValue: {} as Record<string, { unread: number; total: number }> });

  createEffect(() => {
    const value = counts() ?? {};
    if (!isImportActive()) {
      setStableCounts(value);
      publishFolderCounts(value);
    }
  });

  onCleanup(() => {
    if (refreshDebounce) clearTimeout(refreshDebounce);
  });

  /** Show unread count for Inbox/Spam, total count for other folders */
  const displayCount = (name: string): number => {
    const c = stableCounts()?.[name];
    if (!c) return 0;
    return name === "Inbox" || name === "Spam" || name === "Important" ? c.unread : c.total;
  };

  const foldersBeforeSent = [
    { name: "Starred", path: "/?filter=starred", icon: IconStar, filter: "starred" },
    { name: "Important", path: "/?filter=important", icon: IconImportant, filter: IMPORTANT_FILTER_ID },
    { name: "Drafts", path: "/folder/Drafts", icon: IconDrafts },
  ];

  const foldersAfterSent = [
    { name: "Archive", path: "/folder/Archive", icon: IconArchive },
    { name: "Snoozed", path: "/folder/Snoozed", icon: IconClock },
    { name: "Trash", path: "/folder/Trash", icon: IconTrash },
    { name: "Spam", path: "/folder/Spam", icon: IconSpam },
  ];

  const isActive = (path: string, filter?: string) => {
    if (filter) {
      return location.pathname === "/" && labelsState.activeFilter === filter;
    }
    if (path === "/") {
      return location.pathname === "/" && (!labelsState.activeFilter || isCategoryFilterId(labelsState.activeFilter));
    }
    return location.pathname.startsWith(path);
  };

  const isLabelActive = (labelId: string) => {
    return location.pathname === "/" && labelsState.activeFilter === labelId;
  };

  const categoryTabs = createMemo(() => (
    settings.enableCategories ? getCategoryTabs().filter((tab) => tab.key !== PRIMARY_CATEGORY_KEY) : []
  ));
  const isInboxActive = () => location.pathname === "/" && (!labelsState.activeFilter || isCategoryFilterId(labelsState.activeFilter));
  const isCategoryActive = (filterId: string) => location.pathname === "/" && labelsState.activeFilter === filterId;
  const categoryIconById = (icon: CategoryIconId) => {
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

  const handleFolderClick = (filter?: string) => {
    setActiveFilter(filter ?? null);
  };

  return (
    <aside data-testid="left-sidebar-menu" data-shortcut-left-menu="true" class="sidebar-scroll-hidden h-full bg-[var(--card)] border-r border-[var(--border-light)] flex flex-col overflow-y-auto">
      {/* Compose Button */}
      <div class="p-3 pb-2">
        <button
          onClick={() => openCompose()}
          class="w-full flex items-center gap-3 px-5 py-3 rounded-2xl border-none cursor-pointer text-sm font-semibold transition-all duration-200 bg-[var(--compose-bg)] text-[var(--foreground)] hover:bg-[var(--compose-hover)] hover:shadow-md active:scale-[0.98]"
        >
          <IconCompose size={20} />
          <span>Compose</span>
        </button>
      </div>

      {/* Navigation */}
      <nav class={`flex-1 px-3 pt-1 flex flex-col ${density().gap}`}>
        <div class="flex flex-col">
          <A
            href="/"
            class={`flex items-center gap-2 px-4 ${density().sidebarPy} rounded-xl transition-all duration-150 ${density().fontSize} font-medium no-underline ${
              isInboxActive()
                ? "bg-[var(--active-bg)] text-[var(--primary)] font-semibold"
                : "text-[var(--text-secondary)] hover:bg-[var(--hover-bg)]"
            }`}
          >
            <IconInbox
              size={20}
              strokeWidth={isInboxActive() ? 2 : 1.75}
              class={isInboxActive() ? "text-[var(--primary)]" : ""}
            />
            <span class="flex-1">Inbox</span>
            <Show when={displayCount("Inbox") > 0}>
              <span class="text-xs text-[var(--text-muted)]">{displayCount("Inbox")}</span>
            </Show>
            <Show when={settings.enableCategories}>
              <button
                data-testid="sidebar-toggle-categories"
                aria-label={categoriesExpanded() ? "Collapse categories" : "Expand categories"}
                title={categoriesExpanded() ? "Collapse categories" : "Expand categories"}
                class="w-5 h-5 rounded border-none bg-transparent cursor-pointer flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--foreground)]"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setCategoriesExpanded(!categoriesExpanded());
                }}
              >
                <Show when={categoriesExpanded()} fallback={<IconChevronRight size={14} />}>
                  <IconChevronDown size={14} />
                </Show>
              </button>
            </Show>
          </A>
          <Show when={settings.enableCategories && categoriesExpanded() && categoryTabs().length > 0}>
            <div data-testid="sidebar-categories-tree" class="mt-0.5 ml-8 flex flex-col gap-0.5">
              <For each={categoryTabs()}>
                {(tab) => {
                  const CategoryIcon = categoryIconById(tab.icon);
                  return (
                    <A
                      href={`/?filter=${encodeURIComponent(tab.filterId)}`}
                      class={`flex items-center gap-2 px-3 ${density().sidebarPy} rounded-lg ${density().fontSize} font-medium no-underline ${
                        isCategoryActive(tab.filterId)
                          ? "bg-[var(--active-bg)] text-[var(--primary)] font-semibold"
                          : "text-[var(--text-secondary)] hover:bg-[var(--hover-bg)]"
                      }`}
                    >
                      <CategoryIcon size={14} />
                      <span class="flex-1">{tab.name}</span>
                    </A>
                  );
                }}
              </For>
            </div>
          </Show>
        </div>

        {foldersBeforeSent.map((f) => (
          <A
            href={f.path}
            onClick={f.filter ? undefined : () => handleFolderClick(undefined)}
            class={`flex items-center gap-3 px-4 ${density().sidebarPy} rounded-xl transition-all duration-150 ${density().fontSize} font-medium no-underline ${
              isActive(f.path, f.filter)
                ? "bg-[var(--active-bg)] text-[var(--primary)] font-semibold"
                : "text-[var(--text-secondary)] hover:bg-[var(--hover-bg)]"
            }`}
          >
            <f.icon
              size={20}
              strokeWidth={isActive(f.path, f.filter) ? 2 : 1.75}
              class={isActive(f.path, f.filter) ? "text-[var(--primary)]" : ""}
            />
            <span class="flex-1">{f.name}</span>
            <Show when={displayCount(f.name) > 0}>
              <span class="text-xs text-[var(--text-muted)]">{displayCount(f.name)}</span>
            </Show>
          </A>
        ))}

        <div class="flex flex-col gap-0.5">
          <A
            href="/folder/Sent"
            onClick={() => handleFolderClick(undefined)}
            class={`flex items-center gap-3 px-4 ${density().sidebarPy} rounded-xl transition-all duration-150 ${density().fontSize} font-medium no-underline ${
              isActive("/folder/Sent")
                ? "bg-[var(--active-bg)] text-[var(--primary)] font-semibold"
                : "text-[var(--text-secondary)] hover:bg-[var(--hover-bg)]"
            }`}
          >
            <IconSend
              size={20}
              strokeWidth={isActive("/folder/Sent") ? 2 : 1.75}
              class={isActive("/folder/Sent") ? "text-[var(--primary)]" : ""}
            />
            <span class="flex-1">Sent</span>
            <Show when={displayCount("Sent") > 0}>
              <span class="text-xs text-[var(--text-muted)]">{displayCount("Sent")}</span>
            </Show>
            <button
              data-testid="sidebar-toggle-sent"
              aria-label={sentExpanded() ? "Collapse sent subfolders" : "Expand sent subfolders"}
              class="w-5 h-5 rounded border-none bg-transparent cursor-pointer flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--foreground)]"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setSentExpanded(!sentExpanded());
              }}
            >
              <Show when={sentExpanded()} fallback={<IconChevronRight size={14} />}>
                <IconChevronDown size={14} />
              </Show>
            </button>
          </A>
          <Show when={sentExpanded()}>
            <div data-testid="sidebar-sent-tree">
              <A
                href="/folder/Scheduled"
                onClick={() => handleFolderClick(undefined)}
                class={`ml-8 flex items-center gap-2 px-3 ${density().sidebarPy} rounded-lg transition-all duration-150 ${density().fontSize} font-medium no-underline ${
                  isActive("/folder/Scheduled")
                    ? "bg-[var(--active-bg)] text-[var(--primary)] font-semibold"
                    : "text-[var(--text-secondary)] hover:bg-[var(--hover-bg)]"
                }`}
              >
                <IconSendClock
                  size={15}
                  strokeWidth={isActive("/folder/Scheduled") ? 2 : 1.75}
                  class={isActive("/folder/Scheduled") ? "text-[var(--primary)]" : ""}
                />
                <span class="flex-1">Scheduled</span>
                <Show when={displayCount("Scheduled") > 0}>
                  <span class="text-xs text-[var(--text-muted)]">{displayCount("Scheduled")}</span>
                </Show>
              </A>
            </div>
          </Show>
        </div>

        {foldersAfterSent.map((f) => (
          <A
            href={f.path}
            onClick={() => handleFolderClick(f.filter)}
            class={`flex items-center gap-3 px-4 ${density().sidebarPy} rounded-xl transition-all duration-150 ${density().fontSize} font-medium no-underline ${
              isActive(f.path, f.filter)
                ? "bg-[var(--active-bg)] text-[var(--primary)] font-semibold"
                : "text-[var(--text-secondary)] hover:bg-[var(--hover-bg)]"
            }`}
          >
            <f.icon
              size={20}
              strokeWidth={isActive(f.path, f.filter) ? 2 : 1.75}
              class={isActive(f.path, f.filter) ? "text-[var(--primary)]" : ""}
            />
            <span class="flex-1">{f.name}</span>
            <Show when={displayCount(f.name) > 0}>
              <span class="text-xs text-[var(--text-muted)]">{displayCount(f.name)}</span>
            </Show>
          </A>
        ))}
        {/* Contacts */}
        <A
          href="/contacts"
          class={`flex items-center gap-3 px-4 ${density().sidebarPy} rounded-xl transition-all duration-150 ${density().fontSize} font-medium no-underline ${
            location.pathname === "/contacts"
              ? "bg-[var(--active-bg)] text-[var(--primary)] font-semibold"
              : "text-[var(--text-secondary)] hover:bg-[var(--hover-bg)]"
          }`}
        >
          <IconUsers
            size={20}
            strokeWidth={location.pathname === "/contacts" ? 2 : 1.75}
            class={location.pathname === "/contacts" ? "text-[var(--primary)]" : ""}
          />
          <span class="flex-1">Contacts</span>
        </A>

        {/* Labels section */}
        <div class="mt-4 mb-1 px-4 flex items-center justify-between group">
          <div class="flex items-center gap-2 text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">
            <IconLabel size={14} />
            Labels
          </div>
          <button
            class="text-[var(--text-muted)] hover:text-[var(--foreground)] opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer border-none bg-transparent"
            onClick={(e) => {
              e.preventDefault();
              setShowLabelModal(true);
            }}
            title="Manage Labels"
          >
            <IconSettings size={14} />
          </button>
        </div>
        <For each={getVisibleLabels()}>
          {(label) => (
            <A
              href={`/?filter=label:${label.id}`}
              class={`flex items-center gap-3 px-4 ${density().sidebarPy} rounded-xl ${density().fontSize} font-medium transition-colors no-underline cursor-pointer ${
                isLabelActive(label.id)
                  ? "bg-[var(--active-bg)] text-[var(--primary)] font-semibold"
                  : "text-[var(--text-secondary)] hover:bg-[var(--hover-bg)]"
              }`}
            >
              <span
                class="w-3 h-3 rounded-full shrink-0"
                style={{ background: label.color }}
              />
              {label.name}
            </A>
          )}
        </For>
      </nav>

      <LabelModal
        isOpen={showLabelModal()}
        onClose={() => setShowLabelModal(false)}
      />
    </aside>
  );
}
