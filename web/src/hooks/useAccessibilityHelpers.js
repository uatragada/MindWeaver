import { useCallback, useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

function getFocusableElements(container) {
  if (!container) return [];

  return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter((element) => {
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  });
}

export function useFocusTrap(isActive, {
  containerRef,
  initialFocusRef,
  onEscape,
  restoreFocus = true
} = {}) {
  const previouslyFocusedElementRef = useRef(null);

  useEffect(() => {
    if (!isActive) return undefined;

    previouslyFocusedElementRef.current = document.activeElement;
    const container = containerRef?.current;
    const focusTimer = window.setTimeout(() => {
      const firstFocusable = getFocusableElements(container)[0];
      const focusTarget = initialFocusRef?.current ?? firstFocusable ?? container;
      focusTarget?.focus?.({ preventScroll: true });
    }, 0);

    const handleKeyDown = (event) => {
      if (event.key === "Escape" && onEscape) {
        event.preventDefault();
        onEscape(event);
        return;
      }

      if (event.key !== "Tab") return;

      const currentContainer = containerRef?.current;
      const focusableElements = getFocusableElements(currentContainer);
      if (!focusableElements.length) {
        event.preventDefault();
        currentContainer?.focus?.({ preventScroll: true });
        return;
      }

      const first = focusableElements[0];
      const last = focusableElements[focusableElements.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleKeyDown);

      const previousElement = previouslyFocusedElementRef.current;
      if (restoreFocus && previousElement?.isConnected) {
        previousElement.focus?.({ preventScroll: true });
      }
    };
  }, [containerRef, initialFocusRef, isActive, onEscape, restoreFocus]);
}

export function useTextareaSubmitShortcut(onSubmit, { disabled = false } = {}) {
  return useCallback((event) => {
    if (disabled || event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return;
    event.preventDefault();
    onSubmit?.(event);
  }, [disabled, onSubmit]);
}

export function useUnsavedChangesWarning(shouldWarn, message = "You have unsaved changes in MindWeaver.") {
  useEffect(() => {
    if (!shouldWarn) return undefined;

    const handleBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = message;
      return message;
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [message, shouldWarn]);
}
