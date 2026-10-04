import type { Page } from "playwright-core";

// Runs in the page before the app's own scripts: a dot that follows the
// mouse and shrinks on press, so a recorded video shows where the
// pointer is.
export const CURSOR = () => {
  // Once per document, however it got here.
  const seen = window as { __weblabCursor?: boolean };
  if (seen.__weblabCursor) return;
  seen.__weblabCursor = true;
  const dot = document.createElement("div");
  dot.dataset.weblabCursor = "";
  Object.assign(dot.style, {
    position: "fixed",
    left: "0px",
    top: "0px",
    width: "18px",
    height: "18px",
    borderRadius: "50%",
    background: "rgba(255,255,255,0.85)",
    border: "2px solid rgba(0,0,0,0.6)",
    boxShadow: "0 0 8px rgba(0,0,0,0.5)",
    pointerEvents: "none",
    zIndex: "2147483647",
    transform: "translate(-50%,-50%)",
    transition: "transform 80ms",
  });
  const mount = () => document.body.appendChild(dot);
  if (document.body) mount();
  else addEventListener("DOMContentLoaded", mount);
  addEventListener(
    "mousemove",
    (event: MouseEvent) => {
      dot.style.left = `${event.clientX}px`;
      dot.style.top = `${event.clientY}px`;
    },
    true,
  );
  const scale = (to: string) => () => {
    dot.style.transform = `translate(-50%,-50%)${to}`;
  };
  addEventListener("mousedown", scale(" scale(0.6)"), true);
  addEventListener("mouseup", scale(""), true);
};

/** Takes the cursor out of the page again, so a later take can put it back. */
export const REMOVE_CURSOR = () => {
  document.querySelector("[data-weblab-cursor]")?.remove();
  delete (window as { __weblabCursor?: boolean }).__weblabCursor;
};

/**
 * Takes a picture without the drawn cursor in it: the dot is for the
 * recording, and in a screenshot it only hides what is under it.
 */
export async function withoutCursor<T>(page: Page, recorded: boolean, capture: () => Promise<T>): Promise<T> {
  if (!recorded) return capture();
  const show = (visible: boolean) =>
    Promise.all(
      page.frames().map((frame) =>
        frame
          .evaluate((visible) => {
            for (const dot of document.querySelectorAll<HTMLElement>("[data-weblab-cursor]")) dot.style.visibility = visible ? "" : "hidden";
          }, visible)
          .catch(() => {}),
      ),
    );
  await show(false);
  try {
    return await capture();
  } finally {
    await show(true);
  }
}
