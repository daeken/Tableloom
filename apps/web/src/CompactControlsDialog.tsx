import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function useCompactLayout() {
  const [compact, setCompact] = useState(
    () => window.matchMedia("(max-width: 1000px)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(max-width: 1000px)");
    const change = () => setCompact(query.matches);
    change();
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  return compact;
}

export function CompactControlsDialog({
  children,
  close,
  restoreFocus,
}: {
  children: ReactNode;
  close: () => void;
  restoreFocus: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => {
      element?.close();
      restoreFocus();
    };
  }, []);
  return createPortal(
    <dialog
      ref={dialog}
      id="compact-table-controls"
      className="compact-controls-dialog"
      aria-labelledby="compact-controls-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <div className="compact-controls-heading">
        <h1 id="compact-controls-title">Table controls</h1>
        <button autoFocus onClick={close}>
          Close controls
        </button>
      </div>
      {children}
    </dialog>,
    document.body,
  );
}
