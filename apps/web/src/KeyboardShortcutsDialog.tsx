import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
export function KeyboardShortcutsDialog({
  close,
  restoreFocus,
}: {
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
      className="join-card invite-dialog keyboard-shortcuts-dialog"
      aria-labelledby="keyboard-shortcuts-title"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      <span className="eyebrow">BATTLEFIELD KEYS</span>
      <h1 id="keyboard-shortcuts-title">Keyboard shortcuts</h1>
      <p>
        Click the battlefield or Tab to it first. Shortcuts work only while the
        battlefield itself has focus. Text fields, other controls and open
        dialogs keep their own keys.
      </p>
      <table>
        <tbody>
          <tr>
            <th scope="row">Tools</th>
            <td>
              <kbd>V</kbd> Select · <kbd>H</kbd> Pan · <kbd>M</kbd> Measure
              <br />
              <kbd>P</kbd> Pen · <kbd>R</kbd> Room · <kbd>T</kbd> Text
              <br />
              <kbd>O</kbd> Token · <kbd>E</kbd> Eraser
            </td>
          </tr>
          <tr>
            <th scope="row">Create an object</th>
            <td>
              <kbd>N</kbd> Enter coordinates for a token, room or text label.
              Tab between fields, then Create shared object.
            </td>
          </tr>
          <tr>
            <th scope="row">Select objects</th>
            <td>
              <kbd>L</kbd> Open searchable object choices; use Tab and Space,
              then Use selection.
            </td>
          </tr>
          <tr>
            <th scope="row">Move selection</th>
            <td>
              Arrow keys move one canvas unit; Shift moves ten. With Snap
              enabled, each step is one grid spacing (ten with Shift),
              preserving existing offsets. Select mode only; no held-key repeat.
            </td>
          </tr>
          <tr>
            <th scope="row">Position selection</th>
            <td>
              <kbd>G</kbd> Enter exact X/Y for the selected token, drawing or
              group. Select mode only.
            </td>
          </tr>
          <tr>
            <th scope="row">Snap</th>
            <td>
              <kbd>S</kbd> Toggle local snapping
            </td>
          </tr>
          <tr>
            <th scope="row">Zoom</th>
            <td>
              <kbd>+</kbd> / <kbd>=</kbd> In · <kbd>−</kbd> Out · <kbd>0</kbd>{" "}
              Reset view
            </td>
          </tr>
          <tr>
            <th scope="row">History</th>
            <td>
              <kbd>Ctrl/⌘ Z</kbd> Undo
              <br />
              <kbd>Ctrl/⌘ Shift Z</kbd> Redo · <kbd>Ctrl Y</kbd> Redo
            </td>
          </tr>
          <tr>
            <th scope="row">Delete</th>
            <td>
              <kbd>Delete</kbd> / <kbd>Backspace</kbd> Review selected objects
              in Select mode. Confirmation is required.
            </td>
          </tr>
          <tr>
            <th scope="row">Clear / cancel</th>
            <td>
              <kbd>Esc</kbd> Cancel a gesture; otherwise clear selection and
              measurement
            </td>
          </tr>
          <tr>
            <th scope="row">Help</th>
            <td>
              <kbd>?</kbd> Open this guide
            </td>
          </tr>
        </tbody>
      </table>
      <p>
        Finish or cancel a drag before using other shortcuts. Undo, redo and
        deletion review wait for pending edits and a live connection. Held keys
        act once.
      </p>
      <button autoFocus className="shortcuts-close" onClick={close}>
        Close shortcuts
      </button>
    </dialog>,
    document.body,
  );
}
