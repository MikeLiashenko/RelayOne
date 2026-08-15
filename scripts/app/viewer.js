/**
 * RelayOne — in-app media viewer / file preview.
 *
 * A self-contained overlay appended to <body>. Two entry points:
 *   • openImages(list, index) — a lightbox with zoom/pan + prev/next across a
 *     gallery of image attachments.
 *   • openFile(attachment)   — an inline preview for a single file: PDFs, video,
 *     audio and text render in place; anything else falls back to a download
 *     card. Never leaves the app for a new browser tab.
 *
 * Close via ✕, Esc, or backdrop click. Arrow keys navigate the gallery; +/−
 * (and the mouse wheel / double-click) zoom the current image.
 */
export function createViewer() {
  const root = document.createElement("div");
  root.className = "viewer";
  root.hidden = true;
  root.innerHTML = `
    <div class="viewer__backdrop" data-viewer-close></div>
    <header class="viewer__bar">
      <span class="viewer__title" data-viewer-title></span>
      <span class="viewer__counter" data-viewer-counter></span>
      <span class="viewer__actions">
        <a class="viewer__btn" data-viewer-download title="Download" aria-label="Download" download>⭳</a>
        <button type="button" class="viewer__btn" data-viewer-close title="Close" aria-label="Close">✕</button>
      </span>
    </header>
    <button type="button" class="viewer__nav viewer__nav--prev" data-viewer-prev aria-label="Previous">‹</button>
    <button type="button" class="viewer__nav viewer__nav--next" data-viewer-next aria-label="Next">›</button>
    <div class="viewer__stage" data-viewer-stage></div>
  `;
  document.body.appendChild(root);

  const $ = (s) => root.querySelector(s);
  const stage = $("[data-viewer-stage]");
  const titleEl = $("[data-viewer-title]");
  const counterEl = $("[data-viewer-counter]");
  const downloadEl = $("[data-viewer-download]");
  const prevBtn = $("[data-viewer-prev]");
  const nextBtn = $("[data-viewer-next]");

  let gallery = []; // list of image attachments in the current gallery
  let index = 0;
  let mode = "idle"; // "image" | "file" | "idle"

  // Image transform state.
  let scale = 1;
  let tx = 0;
  let ty = 0;
  let imgEl = null;
  let dragging = false;
  let dragStart = null;

  /* -- Open / close ------------------------------------------------------- */

  function openImages(list, startIndex = 0) {
    gallery = Array.isArray(list) ? list.filter((a) => a && a.url) : [];
    if (!gallery.length) return;
    index = Math.max(0, Math.min(startIndex, gallery.length - 1));
    mode = "image";
    show();
    renderImage();
  }

  function openFile(attachment) {
    if (!attachment || !attachment.url) return;
    gallery = [];
    mode = "file";
    show();
    renderFile(attachment);
  }

  function show() {
    root.hidden = false;
    document.addEventListener("keydown", onKey);
    // Prevent the page behind from scrolling while open.
    document.documentElement.style.overflow = "hidden";
  }

  function close() {
    root.hidden = true;
    mode = "idle";
    gallery = [];
    stage.textContent = "";
    imgEl = null;
    document.removeEventListener("keydown", onKey);
    document.documentElement.style.overflow = "";
  }

  /* -- Image lightbox ----------------------------------------------------- */

  function renderImage() {
    const a = gallery[index];
    if (!a) return;
    resetTransform();
    stage.textContent = "";

    imgEl = document.createElement("img");
    imgEl.className = "viewer__img";
    imgEl.alt = a.fileName || "image";
    imgEl.src = a.url;
    imgEl.draggable = false;
    stage.appendChild(imgEl);

    titleEl.textContent = a.fileName || "Image";
    counterEl.textContent = gallery.length > 1 ? `${index + 1} / ${gallery.length}` : "";
    setDownload(a);

    const many = gallery.length > 1;
    prevBtn.hidden = !many;
    nextBtn.hidden = !many;

    wireImageGestures();
    applyTransform();
  }

  function step(delta) {
    if (mode !== "image" || gallery.length < 2) return;
    index = (index + delta + gallery.length) % gallery.length;
    renderImage();
  }

  function resetTransform() {
    scale = 1;
    tx = 0;
    ty = 0;
  }
  function applyTransform() {
    if (!imgEl) return;
    imgEl.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    imgEl.classList.toggle("is-zoomed", scale > 1);
  }
  function setScale(next, cx = 0, cy = 0) {
    const clamped = Math.max(1, Math.min(5, next));
    if (clamped === scale) return;
    // Zoom around the cursor point relative to the image center.
    const factor = clamped / scale;
    tx = cx - (cx - tx) * factor;
    ty = cy - (cy - ty) * factor;
    scale = clamped;
    if (scale === 1) {
      tx = 0;
      ty = 0;
    }
    applyTransform();
  }

  function wireImageGestures() {
    imgEl.addEventListener("dblclick", (e) => {
      e.preventDefault();
      const rect = imgEl.getBoundingClientRect();
      const cx = e.clientX - (rect.left + rect.width / 2);
      const cy = e.clientY - (rect.top + rect.height / 2);
      setScale(scale > 1 ? 1 : 2.5, cx, cy);
    });
    imgEl.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = imgEl.getBoundingClientRect();
      const cx = e.clientX - (rect.left + rect.width / 2);
      const cy = e.clientY - (rect.top + rect.height / 2);
      setScale(scale * (e.deltaY < 0 ? 1.15 : 0.87), cx, cy);
    }, { passive: false });
    imgEl.addEventListener("pointerdown", (e) => {
      if (scale <= 1) return;
      dragging = true;
      dragStart = { x: e.clientX - tx, y: e.clientY - ty };
      imgEl.setPointerCapture(e.pointerId);
    });
    imgEl.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      tx = e.clientX - dragStart.x;
      ty = e.clientY - dragStart.y;
      applyTransform();
    });
    const endDrag = () => { dragging = false; };
    imgEl.addEventListener("pointerup", endDrag);
    imgEl.addEventListener("pointercancel", endDrag);
  }

  /* -- File preview ------------------------------------------------------- */

  function renderFile(a) {
    stage.textContent = "";
    titleEl.textContent = a.fileName || a.kind || "File";
    counterEl.textContent = "";
    setDownload(a);
    prevBtn.hidden = true;
    nextBtn.hidden = true;

    const mime = (a.mimeType || "").toLowerCase();
    const name = (a.fileName || "").toLowerCase();

    if (a.kind === "image") {
      openImages([a], 0);
      return;
    }
    if (a.kind === "video" || mime.startsWith("video/")) {
      const v = document.createElement("video");
      v.className = "viewer__media";
      v.src = a.url;
      v.controls = true;
      v.autoplay = true;
      stage.appendChild(v);
      return;
    }
    if (a.kind === "voice" || mime.startsWith("audio/")) {
      const audio = document.createElement("audio");
      audio.className = "viewer__audio";
      audio.src = a.url;
      audio.controls = true;
      audio.autoplay = true;
      stage.appendChild(audio);
      return;
    }
    if (mime === "application/pdf" || name.endsWith(".pdf")) {
      const frame = document.createElement("iframe");
      frame.className = "viewer__frame";
      frame.src = a.url;
      frame.title = a.fileName || "PDF";
      stage.appendChild(frame);
      return;
    }
    if (mime.startsWith("text/") || /\.(txt|md|json|csv|log|xml|yml|yaml)$/.test(name)) {
      renderText(a);
      return;
    }
    renderFallback(a);
  }

  async function renderText(a) {
    const pre = document.createElement("pre");
    pre.className = "viewer__text";
    pre.textContent = "Loading…";
    stage.appendChild(pre);
    try {
      const res = await fetch(a.url);
      const text = await res.text();
      pre.textContent = text.length > 200_000 ? text.slice(0, 200_000) + "\n\n… (truncated)" : text;
    } catch {
      pre.textContent = "Couldn’t load a preview for this file.";
    }
  }

  function renderFallback(a) {
    const card = document.createElement("div");
    card.className = "viewer__fallback";
    card.innerHTML = `
      <div class="viewer__fallback-icon">📄</div>
      <div class="viewer__fallback-name"></div>
      <div class="viewer__fallback-sub">No in-app preview for this file type.</div>
    `;
    card.querySelector(".viewer__fallback-name").textContent = a.fileName || a.kind || "File";
    const dl = document.createElement("a");
    dl.className = "viewer__fallback-btn";
    dl.href = a.url;
    dl.download = a.fileName || "";
    dl.textContent = "Download";
    card.appendChild(dl);
    stage.appendChild(card);
  }

  /* -- Shared ------------------------------------------------------------- */

  function setDownload(a) {
    downloadEl.href = a.url;
    downloadEl.download = a.fileName || "";
  }

  function onKey(e) {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowLeft") step(-1);
    else if (e.key === "ArrowRight") step(1);
    else if (mode === "image" && (e.key === "+" || e.key === "=")) setScale(scale * 1.2);
    else if (mode === "image" && (e.key === "-" || e.key === "_")) setScale(scale / 1.2);
  }

  root.querySelectorAll("[data-viewer-close]").forEach((n) =>
    n.addEventListener("click", close)
  );
  prevBtn.addEventListener("click", () => step(-1));
  nextBtn.addEventListener("click", () => step(1));

  return { openImages, openFile, close };
}
