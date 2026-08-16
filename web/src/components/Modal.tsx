import { useEffect, useRef, type FormEvent, type ReactNode } from "react";
import { Button } from "./Button";

/**
 * A modal dialog, on the platform's own `<dialog>`.
 *
 * `showModal()` is used rather than a div with a high z-index because the
 * browser then owns the three things a hand-rolled modal always gets partly
 * wrong: the focus trap, the inertness of the page behind it, and Escape. Those
 * are not polish — a dialog you can Tab out of leaves a keyboard user typing
 * into a form they cannot see.
 *
 * What is still ours: returning focus to whatever opened it, and making Escape
 * go through `onClose` rather than closing the element behind React's back.
 */
export function Modal({
  open,
  title,
  description,
  onClose,
  onSubmit,
  submitLabel = "Save",
  busy = false,
  error,
  children,
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  onClose: () => void;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  submitLabel?: string;
  busy?: boolean;
  error?: string | null;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      opener.current = document.activeElement;
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
      // Back where they were. Without this, focus falls to <body> and the next
      // Tab starts from the top of the document — which on this app is the
      // skip link, several screens away from what they were doing.
      if (opener.current instanceof HTMLElement) opener.current.focus();
    }
  }, [open]);

  // Escape closes the <dialog> natively. Routed back through onClose so React
  // stays the one deciding whether it is open.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const cancel = (event: Event) => {
      event.preventDefault();
      onClose();
    };
    dialog.addEventListener("cancel", cancel);
    return () => dialog.removeEventListener("cancel", cancel);
  }, [onClose]);

  return (
    <dialog
      ref={ref}
      aria-labelledby="modal-title"
      className="w-[min(560px,calc(100vw-2rem))] rounded-lg border border-border bg-surface p-0 text-text shadow-card backdrop:bg-black/40"
    >
      <form
        method="dialog"
        onSubmit={(event) => {
          if (!onSubmit) return;
          event.preventDefault();
          onSubmit(event);
        }}
        className="flex flex-col gap-md p-md sm:p-lg"
      >
        <div>
          <h2 id="modal-title" className="font-sans text-[19px] font-bold">
            {title}
          </h2>
          {description ? <p className="mt-1 text-ui text-muted">{description}</p> : null}
        </div>

        <div className="flex flex-col gap-md">{children}</div>

        {/* The refusal sits beside the controls that caused it, in an alert, so
            it is read out the moment it appears rather than being noticed. */}
        {error ? (
          <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-ui text-danger">
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          {onSubmit ? (
            <Button type="submit" variant="primary" busy={busy} busyLabel="Working…">
              {submitLabel}
            </Button>
          ) : null}
        </div>
      </form>
    </dialog>
  );
}
