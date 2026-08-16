import "@testing-library/jest-dom/vitest";

// jsdom does not implement <dialog>. `showModal` and `close` are simply absent,
// so a component that uses the platform's own modal throws the moment it opens.
//
// This is a gap in the TEST ENVIRONMENT, not in the product — real browsers
// have had `<dialog>` for years, and using it is what buys the focus trap, the
// inertness of the page behind, and Escape (see components/Modal.tsx). The
// alternative was a hand-rolled modal that gets all three partly wrong in every
// browser, in exchange for working in this one fake one.
//
// The shim is deliberately thin: it toggles `open` and fires `close`, which is
// enough for a test to assert what is rendered and what a form does. It does
// NOT trap focus or make the rest of the page inert, so a test must not claim
// to have proven either — those are the browser's job and are verified in a
// real browser instead.
if (typeof HTMLDialogElement !== "undefined" && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.show = function show(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event("close"));
  };
}
