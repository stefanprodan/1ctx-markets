// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
//
// The nearest ancestor that scrolls, the shell's main column, for
// anything that follows or reacts to the page's scroll, and keeping a
// row that opens in view.

// the window's bottom a phone's keyboard leaves, in the window's numbers
export function visibleBottom(): number {
  const view = window.visualViewport;
  return view ? view.offsetTop + view.height : window.innerHeight;
}

export function scrollParent(el: Element): HTMLElement | null {
  for (let p = el.parentElement; p !== null; p = p.parentElement) {
    const overflow = getComputedStyle(p).overflowY;
    if (overflow === "auto" || overflow === "scroll") return p;
  }
  return null;
}

// how far to scroll so a row that just opened shows as much of itself
// as fits: never its head above `top`, then its foot up to `bottom`
export function revealBy(
  row: { top: number; bottom: number },
  view: { top: number; bottom: number },
): number {
  if (row.top < view.top) return row.top - view.top;
  return Math.max(0, Math.min(row.bottom - view.bottom, row.top - view.top));
}

// a row just opened: its head goes back to where it was clicked, since
// a row above that closed moves it, then as much of it shows as fits,
// clear of what its scroll margins keep, a sticky page head above and
// its card's edge below
export function reveal(el: HTMLElement, clickedAt: number | null): void {
  const box = scrollParent(el);
  if (box === null) return;
  if (clickedAt !== null) {
    box.scrollTop += el.getBoundingClientRect().top - clickedAt;
  }
  const style = getComputedStyle(el);
  const frame = box.getBoundingClientRect();
  box.scrollTop += revealBy(el.getBoundingClientRect(), {
    top: frame.top + (Number.parseFloat(style.scrollMarginTop) || 0),
    bottom: frame.bottom - (Number.parseFloat(style.scrollMarginBottom) || 0),
  });
}

// Chrome reveals a typed caret inside a sticky head by scrolling the
// page up towards where the head would sit unstuck. The head is always
// in view, so an upward scroll right after typing goes back; a scroll
// down (a stream the chat follows) and the reader's own wheel or touch
// are kept.
const TYPED_MS = 300;
export function pinScroll(input: HTMLElement): () => void {
  const box = scrollParent(input);
  if (box === null) return () => {};
  let top = box.scrollTop;
  let typed = -Infinity;
  const onInput = () => {
    typed = performance.now();
  };
  const onReader = () => {
    typed = -Infinity;
  };
  const onScroll = () => {
    if (box.scrollTop < top && performance.now() - typed < TYPED_MS) {
      box.scrollTop = top;
    } else {
      top = box.scrollTop;
    }
  };
  input.addEventListener("input", onInput);
  box.addEventListener("wheel", onReader, { passive: true });
  box.addEventListener("touchstart", onReader, { passive: true });
  box.addEventListener("scroll", onScroll);
  return () => {
    input.removeEventListener("input", onInput);
    box.removeEventListener("wheel", onReader);
    box.removeEventListener("touchstart", onReader);
    box.removeEventListener("scroll", onScroll);
  };
}
