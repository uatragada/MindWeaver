import { useEffect, useMemo, useRef, useState } from "react";

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
  const [isOpen, setIsOpen] = useState(false);
  const [menuPlacement, setMenuPlacement] = useState("down");
  const rootRef = useRef(null);
  const buttonRef = useRef(null);

  const selectedOption = useMemo(
    () => options.find((option) => option.value === value) ?? options[0] ?? null,
    [options, value]
  );

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
      setIsOpen(false);
    };

    const handleKeyDown = (event) => {
      if (event.key === "Escape") setIsOpen(false);
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  return (
    <div ref={rootRef} className={`select-control ${className}`.trim()}>
      <button
        ref={buttonRef}
        type="button"
        className={`text-input select-trigger ${isOpen ? "is-open" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={ariaLabel}
        onClick={() => setIsOpen((current) => !current)}
      >
        <span>{selectedOption?.label ?? "Select"}</span>
      </button>
      {isOpen ? (
        <div className={`select-menu is-${menuPlacement}`} role="listbox" aria-label={ariaLabel}>
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={`select-option ${option.value === value ? "is-selected" : ""}`}
              onClick={() => {
                onChange(option.value);
                setIsOpen(false);
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
