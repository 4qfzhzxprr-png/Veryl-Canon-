import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";

/**
 * A labelled control.
 *
 * The label is always a real `<label>` bound by id — not a placeholder, and not
 * an aria-label — because a placeholder disappears the moment somebody starts
 * typing, which is exactly when they most need to know what they are filling
 * in. Hint text and error text are wired through `aria-describedby` so they are
 * read out rather than merely seen.
 *
 * **16px minimum on the control**, which is the iOS zoom guard: Safari zooms
 * the whole page when a focused input's text is smaller, and the reader is left
 * scrolled sideways on a form they were part-way through.
 */
const CONTROL =
  "min-h-[44px] w-full rounded-md border border-border bg-surface px-3 text-[16px] text-text placeholder:text-muted focus:border-action focus:outline-none focus:ring-2 focus:ring-action/40";

function Wrapper({
  id,
  label,
  hint,
  error,
  required,
  children,
}: {
  id: string;
  label: string;
  hint?: ReactNode | undefined;
  error?: string | null | undefined;
  required?: boolean | undefined;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-ui font-medium text-text">
        {label}
        {required ? <span className="text-muted"> (required)</span> : null}
      </label>
      {children}
      {hint ? (
        <p id={`${id}-hint`} className="text-meta text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="text-meta text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function described(id: string, hint: unknown, error: unknown): string | undefined {
  const parts = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean);
  return parts.length ? parts.join(" ") : undefined;
}

export function TextField({
  label,
  hint,
  error,
  className = "",
  ...rest
}: { label: string; hint?: ReactNode; error?: string | null } & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <Wrapper id={id} label={label} hint={hint} error={error} required={rest.required}>
      <input
        id={id}
        aria-describedby={described(id, hint, error)}
        aria-invalid={error ? true : undefined}
        {...rest}
        // AFTER the spread, and merged rather than replaced. A caller passing
        // className used to overwrite this wholesale, which silently stripped
        // the 16px minimum — the iOS zoom guard — off whichever control they
        // were only trying to make taller.
        className={`${CONTROL} ${className}`}
      />
    </Wrapper>
  );
}

export function TextArea({
  label,
  hint,
  error,
  className = "",
  ...rest
}: { label: string; hint?: ReactNode; error?: string | null } & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId();
  return (
    <Wrapper id={id} label={label} hint={hint} error={error} required={rest.required}>
      <textarea
        id={id}
        aria-describedby={described(id, hint, error)}
        aria-invalid={error ? true : undefined}
        {...rest}
        className={`${CONTROL} min-h-[88px] py-2 ${className}`}
      />
    </Wrapper>
  );
}

export function SelectField({
  label,
  hint,
  error,
  children,
  className = "",
  ...rest
}: { label: string; hint?: ReactNode; error?: string | null } & SelectHTMLAttributes<HTMLSelectElement>) {
  const id = useId();
  return (
    <Wrapper id={id} label={label} hint={hint} error={error} required={rest.required}>
      <select
        id={id}
        aria-describedby={described(id, hint, error)}
        {...rest}
        className={`${CONTROL} ${className}`}
      >
        {children}
      </select>
    </Wrapper>
  );
}

export function CheckField({
  label,
  hint,
  ...rest
}: { label: string; hint?: ReactNode } & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-start gap-2.5">
        <input
          id={id}
          type="checkbox"
          // 20px and a generous label hit area: a 14px checkbox is a miss on a
          // phone, and the miss lands on whatever is underneath it.
          className="mt-0.5 h-5 w-5 shrink-0 rounded border-border text-action focus:ring-2 focus:ring-action/40"
          aria-describedby={hint ? `${id}-hint` : undefined}
          {...rest}
        />
        <label htmlFor={id} className="text-ui font-medium text-text">
          {label}
        </label>
      </div>
      {hint ? (
        <p id={`${id}-hint`} className="pl-[30px] text-meta text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
