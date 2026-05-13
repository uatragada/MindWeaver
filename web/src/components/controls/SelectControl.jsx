import { useEffect, useId, useMemo, useRef, useState } from "react";

function getSelectMenuPlacement(trigger, optionCount) {
  if (!trigger) return "down";

  const triggerRect = trigger.getBoundingClientRect();
  let boundaryTop = 0;
  let boundaryBottom = window.innerHeight;
  let parent = trigger.parentElement;

  while (parent) {
    const styles = window.getComputedStyle(parent);
    const clipping = `${styles.overflow} ${styles.overflowY}`;

    if (/(auto|scroll|hidden|clip)/.test(clipping)) {
      const parentRect = parent.getBoundingClientRect();
      boundaryTop = Math.max(boundaryTop, parentRect.top);
      boundaryBottom = Math.min(boundaryBottom, parentRect.bottom);
      break;
    }

    parent = parent.parentElement;
  }

  const estimatedMenuHeight = Math.min(260, Math.max(56, optionCount * 42 + 12));
  const spaceBelow = boundaryBottom - triggerRect.bottom;
  const spaceAbove = triggerRect.top - boundaryTop;

  return spaceBelow < estimatedMenuHeight && spaceAbove > spaceBelow ? "up" : "down";
}

export default function SelectControl({ value, onChange, options, className = "", ariaLabel = "Select option" }) {
  const selectId = useId();
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [menuPlacement, setMenuPlacement] = useState("down");
  const rootRef = useRef(null);
  const buttonRef = useRef(null);

  const selectedOption = useMemo(
    () => options.find((option) => option.value === value) ?? options[0] ?? null,
    [options, value]
  );
  const selectedIndex = useMemo(
    () => Math.max(0, options.findIndex((option) => option.value === selectedOption?.value)),
    [options, selectedOption]
  );
  const activeOption = options[activeIndex] ?? selectedOption;

  const openMenu = (nextActiveIndex = selectedIndex) => {
    setActiveIndex(Math.max(0, Math.min(options.length - 1, nextActiveIndex)));
    setIsOpen(true);
  };

  const closeMenu = () => {
    setIsOpen(false);
  };

  const commitOption = (option) => {
    if (!option) return;
    onChange(option.value);
    closeMenu();
  };

  useEffect(() => {
    if (!isOpen) return undefined;

    const updatePlacement = () => {
      setMenuPlacement(getSelectMenuPlacement(buttonRef.current, options.length));
    };

    updatePlacement();
    window.addEventListener("resize", updatePlacement);
    window.addEventListener("scroll", updatePlacement, true);

    return () => {
      window.removeEventListener("resize", updatePlacement);
      window.removeEventListener("scroll", updatePlacement, true);
    };
  }, [isOpen, options.length]);

  useEffect(() => {
    if (!isOpen) return undefined;

    const handlePointerDown = (event) => {
      if (rootRef.current?.contains(event.target)) return;
      closeMenu();
    };

    const handleKeyDown = (event) => {
      if (event.key === "Escape") closeMenu();
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) setActiveIndex(selectedIndex);
  }, [isOpen, selectedIndex]);

  const handleTriggerKeyDown = (event) => {
    if (!options.length) return;

    switch (event.key) {
      case "ArrowDown": {
        event.preventDefault();
        if (!isOpen) {
          openMenu(selectedIndex);
          return;
        }
        setActiveIndex((current) => Math.min(options.length - 1, current + 1));
        break;
      }
      case "ArrowUp": {
        event.preventDefault();
        if (!isOpen) {
          openMenu(selectedIndex);
          return;
        }
        setActiveIndex((current) => Math.max(0, current - 1));
        break;
      }
      case "Home":
        event.preventDefault();
        openMenu(0);
        break;
      case "End":
        event.preventDefault();
        openMenu(options.length - 1);
        break;
      case "Enter":
      case " ": {
        event.preventDefault();
        if (!isOpen) {
          openMenu(selectedIndex);
          return;
        }
        commitOption(options[activeIndex]);
        break;
      }
      case "Escape":
        if (isOpen) {
          event.preventDefault();
          closeMenu();
        }
        break;
      default:
        break;
    }
  };

  return (
    <div
      ref={rootRef}
      className={`select-control is-${menuPlacement} ${isOpen ? "is-open" : ""} ${className}`.trim()}
    >
      <button
        ref={buttonRef}
        type="button"
        className={`text-input select-trigger ${isOpen ? "is-open" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={`${selectId}-listbox`}
        aria-activedescendant={isOpen && activeOption ? `${selectId}-option-${activeOption.value}` : undefined}
        aria-label={ariaLabel}
        onClick={() => {
          if (isOpen) closeMenu();
          else openMenu(selectedIndex);
        }}
        onKeyDown={handleTriggerKeyDown}
      >
        <span>{selectedOption?.label ?? "Select"}</span>
      </button>
      {isOpen ? (
        <div id={`${selectId}-listbox`} className={`select-menu is-${menuPlacement}`} role="listbox" aria-label={ariaLabel}>
          {options.map((option, index) => (
            <button
              id={`${selectId}-option-${option.value}`}
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              tabIndex={-1}
              className={`select-option ${option.value === value ? "is-selected" : ""} ${index === activeIndex ? "is-active" : ""}`.trim()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => {
                commitOption(option);
                buttonRef.current?.focus({ preventScroll: true });
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
