"use client";

/**
 * WebuiContextMenu — the floating right-click menu, plus the placement helper
 * and item shape that drive it. Moved verbatim from the reference client's
 * `components/ContextMenu.tsx` (webui-parity 58, line B).
 *
 * Two adapters, both mechanical:
 *
 *   - The reference routes outside-click through its
 *     `projection/outside-close.js` helper; this tree has no such module, so
 *     the same two rules are stated inline at their only call sites — a
 *     `mousedown` outside the menu closes it (desktop parity: mousedown, not
 *     pointerdown), and Escape closes it.
 *   - Icons come from this tree's `Icon` pack instead of the reference's
 *     inline `WebuiIconContextChevron` / `WebuiIconFolder` components; the
 *     glyphs themselves are the reference's own paths.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";

import { Icon } from "./icons";

export function placeWebuiContextMenu({
  x,
  y,
  width,
  height,
  viewportWidth,
  viewportHeight,
  padding = 8,
}: {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly padding?: number;
}): { readonly left: number; readonly top: number } {
  const maxLeft = Math.max(padding, viewportWidth - width - padding);
  const left = Math.min(Math.max(padding, x), maxLeft);
  const flippedTop = y + height + padding > viewportHeight ? y - height : y;
  const maxTop = Math.max(padding, viewportHeight - height - padding);
  return { left, top: Math.min(Math.max(padding, flippedTop), maxTop) };
}

export type WebuiContextMenuItem =
  | { readonly kind: "divider"; readonly key: string }
  | {
      readonly kind: "item";
      readonly key: string;
      readonly label: string;
      readonly icon?: ReactElement;
      readonly danger?: boolean;
      readonly disabled?: boolean;
      readonly onSelect?: () => void | Promise<void>;
      readonly submenu?: readonly WebuiContextMenuItem[];
    };

export function WebuiContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  readonly x: number;
  readonly y: number;
  readonly items: readonly WebuiContextMenuItem[];
  readonly onClose: () => void;
}): ReactElement {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [openSubmenu, setOpenSubmenu] = useState<string>();
  const [position, setPosition] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    setPosition({ left: x, top: y });
  }, [x, y]);
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu || typeof window === "undefined") return;
    const next = placeWebuiContextMenu({
      x,
      y,
      width: menu.offsetWidth,
      height: menu.offsetHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    setPosition((current) =>
      current.left === next.left && current.top === next.top ? current : next,
    );
  }, [items, x, y]);
  useEffect(() => {
    const handlePointerDown = (event: globalThis.MouseEvent) => {
      const insideContainer =
        menuRef.current?.contains(event.target as Node) ?? false;
      // The reference's context-menu surface subscribes to `mousedown` (NOT
      // `pointerdown` — desktop parity); a press inside the menu is not a
      // close.
      if (!insideContainer) onClose();
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);
  const renderItems = (menuItems: readonly WebuiContextMenuItem[]) =>
    menuItems.map((item) => {
      if (item.kind === "divider") {
        return <div key={item.key} className="webui-context-menu-divider" role="separator" />;
      }
      const hasSubmenu = Boolean(item.submenu?.length);
      return (
        <div
          key={item.key}
          className="webui-context-menu-item-wrap"
          onMouseEnter={() => hasSubmenu && setOpenSubmenu(item.key)}
          onMouseLeave={() => hasSubmenu && setOpenSubmenu(undefined)}
        >
          <button
            type="button"
            className={`webui-context-menu-item${item.danger ? " is-danger" : ""}`}
            disabled={item.disabled}
            aria-disabled={item.disabled ? "true" : undefined}
            onClick={() => {
              if (hasSubmenu) {
                setOpenSubmenu((current) => (current === item.key ? undefined : item.key));
                return;
              }
              onClose();
              void item.onSelect?.();
            }}
          >
            <span className="webui-context-menu-item-icon">{item.icon ?? null}</span>
            <span className="webui-context-menu-item-label">{item.label}</span>
            {hasSubmenu ? (
              <Icon name="chevronRight" size={16} className="webui-context-menu-chevron" />
            ) : null}
          </button>
          {hasSubmenu && openSubmenu === item.key ? (
            <div className="webui-context-menu-submenu" role="menu">
              {renderItems(item.submenu ?? [])}
            </div>
          ) : null}
        </div>
      );
    });
  const menu = (
    <div
      ref={menuRef}
      role="menu"
      data-testid="webui-context-menu"
      className="webui-context-menu"
      style={{ left: position.left, top: position.top }}
    >
      {renderItems(items)}
    </div>
  );
  return typeof document !== "undefined" ? createPortal(menu, document.body) : menu;
}
