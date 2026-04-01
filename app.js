(() => {
  const OUT_W = 1080;
  const OUT_H = 1920;

  const JPEG_QUALITY = 0.92;
  /** Fallback FPS when `captureStream()` without a rate is unsupported. */
  const RECORD_FPS = 60;
  /**
   * Gallery export: canvas `captureStream()` with no frame rate can merge identical frames and
   * shrink the encoded timeline vs wall clock. Fixed FPS keeps duration aligned with playback.
   */
  const GALLERY_EXPORT_CAPTURE_FPS = 30;
  /** Hidden off-screen `<video>` used only as a decode source (must stay in sync with ensureGalleryVideoEl). */
  const GALLERY_SOURCE_VIDEO_HIDDEN_STYLE =
    "position:absolute;width:0;height:0;opacity:0;pointer-events:none;clip:rect(0,0,0,0);overflow:hidden;";
  /** Max long edge (px) for mobile dialog video preview buffer — balances smooth playback and GPU cost. */
  const PREVIEW_CANVAS_MAX_EDGE = 720;
  const RECORD_VIDEO_BITRATE = 12_000_000;
  const OVERLAY_CACHE_BUST = "3";
  const OVERLAY_SRC = "overlay-frame.png?v=" + OVERLAY_CACHE_BUST;

  const FALLBACK_PHOTO_HOLE_NORM = { x: 0.02, y: 0.17, w: 0.96, h: 0.546 };

  /**
   * Firebase / GA4 custom events. Totals (e.g. all photo downloads) = Event count for `photo_download` in Analytics.
   *
   * | Event | When |
   * |-------|------|
   * | campaign_app_open | App shell ready |
   * | camera_stream_start / camera_stream_stop | Camera opened or closed |
   * | camera_facing_switch | Front/back switched |
   * | camera_photo_capture | Take photo (live camera) |
   * | camera_record_start / camera_record_complete | Start/stop framed screen recording |
   * | gallery_image_upload / gallery_video_upload | Gallery file loaded for edit |
   * | gallery_image_load_error / gallery_video_load_error | Gallery pick failed |
   * | photo_download | JPEG save triggered |
   * | video_download | File saved or shared (video_source, method, format, layout) |
   * | overlay_ready / overlay_error | Frame PNG loaded or failed |
   * | gallery_framed_export | User started framed export from gallery video (path: precache_hit | wait_precache | full_encode) |
   * | gallery_framed_export_fail | Encode/delivery produced no file |
   * | camera_stream_error | getUserMedia or preview failed |
   * | gallery_picker_open | User tapped upload / gallery (file picker) |
   */
  function logCampaignEvent(name, params) {
    try {
      if (typeof window.campaignLogEvent === "function") {
        window.campaignLogEvent(name, params);
      }
    } catch {
      /* ignore */
    }
  }

  /**
   * Static `<input type="file">` in HTML paints "Choose file" before CSS and can ignore `.gallery-file-input`.
   * Inject with inline `display:none` so the native control is never shown.
   * @returns {HTMLInputElement}
   */
  function ensureGalleryFileInput() {
    let el = document.getElementById("galleryInput");
    if (el instanceof HTMLInputElement) return el;

    const host = document.createElement("div");
    host.id = "gallery-input-host";
    host.setAttribute("aria-hidden", "true");
    host.style.cssText = "display:none!important;position:absolute;width:0;height:0;overflow:hidden;clip:rect(0,0,0,0);";

    el = document.createElement("input");
    el.id = "galleryInput";
    el.type = "file";
    el.accept = "image/*,video/*";
    el.setAttribute("aria-hidden", "true");
    el.setAttribute("tabindex", "-1");
    el.title = "";
    el.style.cssText = "display:none!important;visibility:hidden!important;position:absolute;width:0!important;height:0!important;opacity:0!important;margin:0!important;padding:0!important;border:0!important;";
    host.appendChild(el);
    document.body.appendChild(host);
    return el;
  }

  function initApp() {
    const video = document.getElementById("video");
    const liveFrameOverlay = document.getElementById("liveFrameOverlay");
    const liveUploadPreview = document.getElementById("liveUploadPreview");
    const galleryInput = ensureGalleryFileInput();
    const galleryResultDialog = document.getElementById("galleryResultDialog");
    const galleryResultPreviewImg = document.getElementById("galleryResultPreviewImg");
    const galleryResultDialogClose = document.getElementById("galleryResultDialogClose");
    const galleryResultDialogDownload = document.getElementById("galleryResultDialogDownload");
    const galleryResultDialogExportVideo = document.getElementById("galleryResultDialogExportVideo");
    const galleryVideoExportHint = document.getElementById("galleryVideoExportHint");
    const desktopGalleryExportHint = document.getElementById("desktopGalleryExportHint");
    const galleryResultPreviewCanvas = document.getElementById("galleryResultPreviewCanvas");
    const galleryResultPreviewVideo = document.getElementById("galleryResultPreviewVideo");

    const statusEl = document.getElementById("status");
    const statusDesktopEl = document.getElementById("status-desktop");

    let sourceCanvas = null;
    let stream = null;
    /** @type {'user' | 'environment'} */
    let facingMode = "user";
    let overlayFailed = false;
    let overlayHasTransparency = false;
    /** @type {string | null} */
    let galleryObjectUrl = null;
    /** Why the mobile preview dialog was opened — drives close behavior. */
    /** @type {'gallery' | 'capture' | 'framed-video' | null} */
    let mobilePreviewOrigin = null;
    /** Mobile: blob shown in dialog until user downloads (fixes iOS async download). */
    /** @type {{ blob: Blob; url: string; ext: string; mime: string } | null} */
    let mobilePendingFramedVideo = null;
    /** @type {null | 'camera' | 'gallery-export'} */
    let framedVideoContext = null;
    /** @type {null | 'image' | 'video'} */
    let galleryMediaMode = null;
    let isRecording = false;
    let exportingFramedVideo = false;
    /** @type {MediaRecorder | null} */
    let cameraMediaRecorder = null;
    /** @type {BlobPart[]} */
    let cameraRecordChunks = [];
    /** @type {(() => void) | null} */
    let cancelCameraComposeLoop = null;
    /** @type {(() => void) | null} */
    let cancelExportComposeLoop = null;
    /** @type {(() => void) | null} */
    let cancelGalleryDialogPreviewLoop = null;
    /** @type {HTMLVideoElement | null} */
    let galleryVideoEl = null;
    /** Second decode source for background framed export (keeps preview `galleryVideoEl` playing). */
    /** @type {HTMLVideoElement | null} */
    let galleryEncodeVideoEl = null;
    /** Off-screen composite target so pre-encode does not repaint visible `#result`. */
    /** @type {HTMLCanvasElement | null} */
    let galleryExportCanvas = null;
    /** Bumped to cancel in-flight gallery pre-encode when the asset changes. */
    let galleryPreExportRunId = 0;
    /** Object URL key for cached pre-export (must match current `galleryObjectUrl`). */
    let galleryPreExportSrcKey = "";
    /** @type {{ blob: Blob; outType: string; ext: string } | null} */
    let galleryPreExportResult = null;
    /** @type {Promise<{ blob: Blob; outType: string; ext: string } | null> | null} */
    let galleryPreExportPromise = null;

    const shell = document.querySelector(".camera-app");

    function ensureGalleryVideoEl() {
      if (galleryVideoEl) return galleryVideoEl;
      const el = document.createElement("video");
      el.setAttribute("playsinline", "");
      el.setAttribute("webkit-playsinline", "");
      el.playsInline = true;
      el.muted = true;
      el.setAttribute("aria-hidden", "true");
      el.className = "gallery-source-video";
      el.style.cssText = GALLERY_SOURCE_VIDEO_HIDDEN_STYLE;
      document.body.appendChild(el);
      galleryVideoEl = el;
      return el;
    }

    function ensureGalleryEncodeVideoEl() {
      if (galleryEncodeVideoEl) return galleryEncodeVideoEl;
      const el = document.createElement("video");
      el.setAttribute("playsinline", "");
      el.setAttribute("webkit-playsinline", "");
      el.playsInline = true;
      el.muted = true;
      el.setAttribute("aria-hidden", "true");
      el.className = "gallery-encode-video";
      el.style.cssText = GALLERY_SOURCE_VIDEO_HIDDEN_STYLE;
      document.body.appendChild(el);
      galleryEncodeVideoEl = el;
      return el;
    }

    function ensureGalleryExportCanvas() {
      if (galleryExportCanvas) return galleryExportCanvas;
      const c = document.createElement("canvas");
      c.setAttribute("aria-hidden", "true");
      c.className = "gallery-export-canvas";
      c.style.cssText =
        "position:absolute;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;";
      document.body.appendChild(c);
      galleryExportCanvas = c;
      return c;
    }

    function invalidateGalleryPreExport() {
      galleryPreExportRunId++;
      galleryPreExportResult = null;
      galleryPreExportPromise = null;
      galleryPreExportSrcKey = "";
    }

    /**
     * Prefer MP4 (H.264) for social uploads; fall back to WebM where MediaRecorder has no MP4.
     */
    function pickRecorderMime() {
      if (typeof MediaRecorder === "undefined") return "";
      const candidates = [
        "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
        "video/mp4;codecs=avc1.4d002a,mp4a.40.2",
        "video/mp4;codecs=avc1.42E01E",
        "video/mp4;codecs=avc1.4d002a",
        "video/mp4;codecs=avc1",
        "video/mp4",
        "video/webm;codecs=vp9",
        "video/webm;codecs=vp8",
        "video/webm",
      ];
      for (const t of candidates) {
        if (MediaRecorder.isTypeSupported(t)) return t;
      }
      return "";
    }

    /**
     * @param {Blob} blob
     * @param {string} ext
     * @param {Record<string, string | number>} [extra] e.g. video_source: camera_record | gallery_export
     */
    function downloadVideoBlob(blob, ext, extra = {}) {
      if (!blob || blob.size === 0) {
        setStatus("Nothing to download (empty video file).", true);
        return;
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const name = `campaign-framed-${stamp}.${ext}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.rel = "noopener";
      a.style.cssText = "position:fixed;left:-9999px;top:0;";
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        a.remove();
        URL.revokeObjectURL(url);
      }, 2500);
      setStatus(`Downloaded ${name}`);
      logCampaignEvent("video_download", {
        method: "download",
        format: String(ext),
        ...analyticsLayoutParam(),
        ...extra,
      });
    }

    /**
     * @returns {Promise<boolean>} true if user completed save/share; false if they cancelled share sheet only.
     */
    /**
     * @param {Record<string, string | number>} [extra] Passed into video_download (e.g. video_source).
     */
    async function saveFramedVideoWithUserGesture(blob, ext, extra = {}) {
      if (!blob || blob.size === 0) {
        setStatus("Nothing to save (empty video file).", true);
        return false;
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const name = `campaign-framed-${stamp}.${ext}`;
      const mime = blob.type || (ext === "mp4" ? "video/mp4" : "video/webm");

      try {
        if (typeof File !== "undefined" && navigator.share) {
          const file = new File([blob], name, { type: mime });
          const shareData = { files: [file], title: name };
          if (!navigator.canShare || navigator.canShare(shareData)) {
            await navigator.share(shareData);
            setStatus(`Shared ${name}`);
            logCampaignEvent("video_download", {
              method: "share",
              format: String(ext),
              ...analyticsLayoutParam(),
              ...extra,
            });
            return true;
          }
        }
      } catch (e) {
        const err = /** @type {Error & { name?: string }} */ (e);
        if (err?.name === "AbortError") {
          setStatus("Share cancelled.");
          return false;
        }
        console.warn(err);
      }

      downloadVideoBlob(blob, ext, extra);
      return true;
    }

    function revokeMobilePendingFramedVideo() {
      if (galleryResultPreviewVideo) {
        galleryResultPreviewVideo.pause();
        galleryResultPreviewVideo.removeAttribute("src");
        try {
          galleryResultPreviewVideo.load();
        } catch {
          /* ignore */
        }
        galleryResultPreviewVideo.hidden = true;
      }
      if (mobilePendingFramedVideo?.url) {
        try {
          URL.revokeObjectURL(mobilePendingFramedVideo.url);
        } catch {
          /* ignore */
        }
      }
      mobilePendingFramedVideo = null;
    }

    function resetDialogFooterButtons() {
      if (galleryResultDialogDownload) {
        galleryResultDialogDownload.textContent = "Download photo";
        galleryResultDialogDownload.hidden = false;
      }
      if (galleryResultDialogExportVideo) {
        galleryResultDialogExportVideo.textContent = "Download video";
        galleryResultDialogExportVideo.classList.remove("gallery-result-dialog__export-video--primary");
        galleryResultDialogExportVideo.classList.remove("gallery-result-dialog__export-video--waiting");
        galleryResultDialogExportVideo.disabled = false;
        galleryResultDialogExportVideo.removeAttribute("aria-busy");
        galleryResultDialogExportVideo.hidden = true;
      }
      if (galleryVideoExportHint) {
        galleryVideoExportHint.hidden = true;
        galleryVideoExportHint.textContent = "";
      }
    }

    /**
     * Mobile: show recorded/exported video in the dialog; user taps Download (fresh gesture).
     * Desktop: immediate file download.
     * @param {'camera' | 'gallery-export'} context
     */
    function offerMobileFramedVideoPreview(blob, mime, ext, context) {
      if (!blob || blob.size === 0) {
        setStatus("Video file is empty — try a shorter clip or another browser.", true);
        return;
      }

      const videoSource = context === "camera" ? "camera_record" : "gallery_export";

      if (!isMobileLayout()) {
        downloadVideoBlob(blob, ext, { video_source: videoSource });
        return;
      }

      framedVideoContext = context;
      revokeMobilePendingFramedVideo();
      stopMobileGalleryDialogVideoPreview();

      const url = URL.createObjectURL(blob);
      mobilePendingFramedVideo = {
        blob,
        url,
        ext,
        mime: mime || blob.type || "video/mp4",
      };

      if (galleryResultPreviewImg) {
        galleryResultPreviewImg.hidden = true;
        galleryResultPreviewImg.removeAttribute("src");
      }
      if (galleryResultPreviewCanvas) galleryResultPreviewCanvas.hidden = true;
      if (galleryResultDialogExportVideo) {
        galleryResultDialogExportVideo.hidden = true;
        galleryResultDialogExportVideo.classList.remove("gallery-result-dialog__export-video--primary");
        galleryResultDialogExportVideo.classList.remove("gallery-result-dialog__export-video--waiting");
      }
      if (galleryVideoExportHint) {
        galleryVideoExportHint.hidden = true;
        galleryVideoExportHint.textContent = "";
      }
      if (galleryResultDialogDownload) {
        galleryResultDialogDownload.hidden = false;
        galleryResultDialogDownload.textContent = "Download video";
      }

      const pv = galleryResultPreviewVideo;
      if (!pv) {
        downloadVideoBlob(blob, ext, { video_source: videoSource });
        return;
      }

      pv.hidden = false;
      pv.src = url;
      pv.muted = true;
      pv.playsInline = true;
      pv.setAttribute("playsinline", "");

      mobilePreviewOrigin = "framed-video";
      galleryResultDialog?.showModal();
      void pv.play().catch(() => {});

      if (context === "camera") {
        setActionDisabled("capture", true);
        setActionDisabled("switch", true);
        setActionDisabled("stop", true);
      }

      setStatus("Preview your framed video — tap Download video to save.");
    }

    function waitVideoSeeked(el) {
      return new Promise((resolve) => {
        if (el.readyState < 2) {
          resolve();
          return;
        }
        const onSeeked = () => {
          el.removeEventListener("seeked", onSeeked);
          resolve();
        };
        el.addEventListener("seeked", onSeeked, { once: true });
      });
    }

    function setGalleryMediaMode(mode) {
      galleryMediaMode = mode;
      shell?.setAttribute("data-gallery-media", mode || "none");
      if (galleryResultDialogExportVideo) {
        galleryResultDialogExportVideo.hidden = mode !== "video" || !isMobileLayout();
      }
      syncGalleryVideoExportReadyUi();
    }

    function getActiveComposeSource() {
      if (galleryMediaMode === "video" && galleryVideoEl?.src) {
        const gv = galleryVideoEl;
        if (gv.readyState >= 2 && gv.videoWidth > 0 && gv.videoHeight > 0) return gv;
      }
      if (sourceCanvas) return sourceCanvas;
      return null;
    }

    /**
     * Draw one framed frame from a video or canvas source into a canvas (visible `#result` or off-screen export buffer).
     * @param {HTMLCanvasElement} rc
     * @param {HTMLVideoElement | HTMLCanvasElement} source
     * @param {boolean} [silent] Skip status updates (recording / export loops).
     */
    function composeOntoCanvas(rc, source, silent = false) {
      if (!rc) return;

      let iw = 0;
      let ih = 0;
      if (source instanceof HTMLVideoElement) {
        iw = source.videoWidth;
        ih = source.videoHeight;
      } else if (source instanceof HTMLCanvasElement) {
        iw = source.width;
        ih = source.height;
      }
      if (!iw || !ih) return;

      const { w, h } = compositeSize();
      rc.width = w;
      rc.height = h;
      const rctx = rc.getContext("2d", { alpha: true });
      if (!rctx) return;

      if (overlayFailed || !overlayImg.naturalWidth) {
        rctx.fillStyle = "#000000";
        rctx.fillRect(0, 0, w, h);
        drawSourceCoverInRect(rctx, source, 0, 0, w, h);
        if (!silent) {
          if (overlayFailed) {
            setStatus("Frame missing — photo only at " + w + "×" + h + ".", true);
          } else {
            setStatus("Loading frame…");
          }
        }
        return;
      }

      drawCameraWithFrame(rctx, source, w, h);
    }

    /**
     * Draw one framed frame from a video or canvas source into `#result`.
     * @param {HTMLVideoElement | HTMLCanvasElement} source
     * @param {boolean} [silent] Skip status updates (recording / export loops).
     */
    function composeFromMediaSource(source, silent = false) {
      const rc = document.getElementById("result");
      composeOntoCanvas(rc, source, silent);
    }

    /**
     * Same framing as {@link composeFromMediaSource} but into an arbitrary canvas (e.g. mobile preview).
     * Caller sets destCanvas.width / height before calling.
     */
    function composeFromMediaSourceToCanvas(destCanvas, source, silent = false) {
      if (!destCanvas) return;

      let iw = 0;
      let ih = 0;
      if (source instanceof HTMLVideoElement) {
        iw = source.videoWidth;
        ih = source.videoHeight;
      } else if (source instanceof HTMLCanvasElement) {
        iw = source.width;
        ih = source.height;
      }
      if (!iw || !ih) return;

      const w = destCanvas.width;
      const h = destCanvas.height;
      if (!w || !h) return;
      const rctx = destCanvas.getContext("2d", { alpha: true });
      if (!rctx) return;

      if (overlayFailed || !overlayImg.naturalWidth) {
        rctx.fillStyle = "#000000";
        rctx.fillRect(0, 0, w, h);
        drawSourceCoverInRect(rctx, source, 0, 0, w, h);
        if (!silent && overlayFailed) {
          setStatus("Frame missing — preview at " + w + "×" + h + ".", true);
        }
        return;
      }

      drawCameraWithFrame(rctx, source, w, h);
    }

    function getDialogPreviewBufferSize() {
      const { w: ow, h: oh } = compositeSize();
      const maxEdge = PREVIEW_CANVAS_MAX_EDGE;
      if (!ow || !oh) return { w: maxEdge, h: Math.round((OUT_H / OUT_W) * maxEdge) };
      const ratio = ow / oh;
      if (ow >= oh) {
        const w = Math.min(ow, maxEdge);
        return { w, h: Math.max(1, Math.round(w / ratio)) };
      }
      const h = Math.min(oh, maxEdge);
      return { w: Math.max(1, Math.round(h * ratio)), h };
    }

    /**
     * Fixed-FPS capture first so MediaRecorder gets a steady timeline (variable capture can
     * collapse repeated canvas pixels and shorten the file when compositing outpaces the clip).
     * @param {HTMLCanvasElement} rc
     * @param {number} [captureFps] When set (e.g. gallery export), tried before {@link RECORD_FPS}.
     * @returns {MediaStream | null}
     */
    function captureCanvasStreamForRecord(rc, captureFps) {
      if (!rc?.captureStream) return null;
      const rates = [];
      if (typeof captureFps === "number" && captureFps > 0) rates.push(captureFps);
      rates.push(RECORD_FPS);
      for (const fps of rates) {
        try {
          const s = rc.captureStream(fps);
          if (s?.getVideoTracks().length) return s;
        } catch {
          /* ignore */
        }
      }
      try {
        const s = rc.captureStream();
        if (s?.getVideoTracks().length) return s;
      } catch {
        /* ignore */
      }
      return null;
    }

    /** @param {HTMLVideoElement} el */
    function getVideoTimelineEnd(el) {
      let max = 0;
      const d = el.duration;
      if (Number.isFinite(d) && d > 0) max = Math.max(max, d);
      try {
        if (el.seekable && el.seekable.length > 0) {
          const e = el.seekable.end(el.seekable.length - 1);
          if (Number.isFinite(e) && e > 0) max = Math.max(max, e);
        }
      } catch {
        /* ignore */
      }
      return max;
    }

    /** @param {HTMLVideoElement} gv */
    function prepareGalleryVideoLayoutForExport(gv) {
      if (!gv) return;
      const w = Math.max(2, gv.videoWidth || 2);
      const h = Math.max(2, gv.videoHeight || 2);
      gv.style.cssText = `position:absolute;left:-9999px;top:0;width:${w}px;height:${h}px;opacity:0;pointer-events:none;overflow:hidden;`;
    }

    /** @param {HTMLVideoElement} gv */
    function restoreGalleryVideoHiddenLayout(gv) {
      if (!gv) return;
      gv.style.cssText = GALLERY_SOURCE_VIDEO_HIDDEN_STYLE;
    }

    /**
     * One compose per decoded video frame when supported (smoother than raw rAF).
     * @param {HTMLVideoElement} videoEl
     * @param {() => boolean} shouldContinue
     * @param {() => void} frameFn
     * @returns {() => void} cancel
     */
    function startVideoComposeLoop(videoEl, shouldContinue, frameFn) {
      let vfcId = /** @type {number | null} */ (null);
      let rafId = 0;
      let cancelled = false;

      function cancelLoop() {
        cancelled = true;
        if (vfcId != null && typeof videoEl.cancelVideoFrameCallback === "function") {
          try {
            videoEl.cancelVideoFrameCallback(vfcId);
          } catch {
            /* ignore */
          }
          vfcId = null;
        }
        if (rafId) {
          cancelAnimationFrame(rafId);
          rafId = 0;
        }
      }

      function scheduleNext() {
        if (cancelled || !shouldContinue()) return;
        if (typeof videoEl.requestVideoFrameCallback === "function") {
          vfcId = videoEl.requestVideoFrameCallback(() => {
            vfcId = null;
            if (cancelled || !shouldContinue()) return;
            frameFn();
            scheduleNext();
          });
        } else {
          rafId = requestAnimationFrame(() => {
            rafId = 0;
            if (cancelled || !shouldContinue()) return;
            frameFn();
            scheduleNext();
          });
        }
      }

      scheduleNext();
      return cancelLoop;
    }

    function stopMobileGalleryDialogVideoPreview() {
      cancelGalleryDialogPreviewLoop?.();
      cancelGalleryDialogPreviewLoop = null;
      const gv = galleryVideoEl;
      if (gv) {
        gv.loop = false;
        gv.pause();
        try {
          gv.currentTime = 0;
        } catch {
          /* ignore */
        }
      }
      const cvs = galleryResultPreviewCanvas;
      if (cvs) {
        cvs.hidden = true;
        const ctx = cvs.getContext("2d");
        if (ctx) ctx.clearRect(0, 0, cvs.width, cvs.height);
      }
      if (galleryResultPreviewImg) galleryResultPreviewImg.hidden = false;
      const pv = galleryResultPreviewVideo;
      if (pv) {
        pv.pause();
        pv.removeAttribute("src");
        try {
          pv.load();
        } catch {
          /* ignore */
        }
        pv.hidden = true;
      }
    }

    function startMobileGalleryDialogVideoPreview() {
      const cvs = galleryResultPreviewCanvas;
      const gv = galleryVideoEl;
      if (!cvs || !gv || galleryMediaMode !== "video") return;

      cancelGalleryDialogPreviewLoop?.();
      cancelGalleryDialogPreviewLoop = null;

      if (galleryResultPreviewVideo) {
        galleryResultPreviewVideo.pause();
        galleryResultPreviewVideo.removeAttribute("src");
        galleryResultPreviewVideo.hidden = true;
      }

      if (galleryResultPreviewImg) {
        galleryResultPreviewImg.removeAttribute("src");
        galleryResultPreviewImg.alt = "";
        galleryResultPreviewImg.hidden = true;
      }
      cvs.hidden = false;

      const { w, h } = getDialogPreviewBufferSize();
      cvs.width = w;
      cvs.height = h;

      gv.loop = true;
      gv.muted = true;

      cancelGalleryDialogPreviewLoop = startVideoComposeLoop(
        gv,
        () =>
          Boolean(
            galleryResultDialog?.open &&
              galleryMediaMode === "video" &&
              mobilePreviewOrigin === "gallery" &&
              !exportingFramedVideo
          ),
        () => {
          composeFromMediaSourceToCanvas(cvs, gv, true);
        }
      );

      void gv.play().catch(() => {});
    }

    function refreshRecordAndExportButtons() {
      const camOn = shell?.getAttribute("data-camera") === "on";
      const hasStream = !!stream;
      const busy = exportingFramedVideo || isRecording;

      document.querySelectorAll('[data-action="record-toggle"]').forEach((el) => {
        if (!(el instanceof HTMLButtonElement)) return;
        el.disabled = !camOn || !hasStream || exportingFramedVideo;
        const isDock = el.classList.contains("dock-record-btn");
        el.textContent = isRecording ? (isDock ? "Stop" : "Stop recording") : isDock ? "Rec" : "Record video";
        el.classList.toggle("is-recording", isRecording);
        el.setAttribute("aria-pressed", isRecording ? "true" : "false");
      });

      syncGalleryVideoExportReadyUi();
    }

    const mobileLayoutMq = window.matchMedia("(max-width: 899px)");
    if (typeof mobileLayoutMq.addEventListener === "function") {
      mobileLayoutMq.addEventListener("change", () => refreshRecordAndExportButtons());
    } else {
      mobileLayoutMq.addListener?.(() => refreshRecordAndExportButtons());
    }

    function isMobileLayout() {
      return mobileLayoutMq.matches;
    }

    /** @returns {Record<string, string>} */
    function analyticsLayoutParam() {
      return { layout: isMobileLayout() ? "mobile" : "desktop" };
    }

    function inferPhotoDownloadSource() {
      if (mobilePreviewOrigin === "capture") return "camera_preview";
      if (galleryMediaMode === "image") return "gallery_image";
      if (galleryMediaMode === "video") return "gallery_video_frame";
      return "other";
    }

    function setCameraLive(on) {
      shell?.setAttribute("data-camera", on ? "on" : "off");
    }

    function setActionDisabled(action, disabled) {
      document.querySelectorAll(`[data-action="${action}"]`).forEach((el) => {
        if (el instanceof HTMLButtonElement) el.disabled = disabled;
      });
    }

    function setStatus(message, isError = false) {
      [statusEl, statusDesktopEl].forEach((el) => {
        if (!el) return;
        el.textContent = message;
        el.classList.toggle("error", isError);
      });
    }

    function computeContainRect(iw, ih, cw, ch) {
      const ir = iw / ih;
      const cr = cw / ch;
      let dw;
      let dh;
      if (ir > cr) {
        dw = cw;
        dh = cw / ir;
      } else {
        dh = ch;
        dw = ch * ir;
      }
      const dx = (cw - dw) / 2;
      const dy = (ch - dh) / 2;
      return { dx, dy, dw, dh };
    }

    function drawSourceCoverInRect(c, source, ex, ey, ew, eh) {
      let iw = 0;
      let ih = 0;
      if (source instanceof HTMLVideoElement) {
        iw = source.videoWidth;
        ih = source.videoHeight;
      } else if (source instanceof HTMLCanvasElement || source instanceof HTMLImageElement) {
        iw = source.width;
        ih = source.height;
      } else {
        return;
      }
      if (!iw || !ih) return;
      const scale = Math.max(ew / iw, eh / ih);
      const dw = iw * scale;
      const dh = ih * scale;
      const dx = ex + (ew - dw) / 2;
      const dy = ey + (eh - dh) / 2;
      c.imageSmoothingEnabled = true;
      c.imageSmoothingQuality = "high";
      c.drawImage(source, 0, 0, iw, ih, dx, dy, dw, dh);
    }

    function checkOverlayTransparency(img) {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (!w || !h) return false;

      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const cctx = c.getContext("2d");
      if (!cctx) return false;

      let data;
      try {
        cctx.drawImage(img, 0, 0);
        data = cctx.getImageData(0, 0, w, h).data;
      } catch {
        return false;
      }

      let lowAlpha = 0;
      const x0 = Math.floor(w * 0.1);
      const x1 = Math.floor(w * 0.9);
      const y0 = Math.floor(h * 0.08);
      const y1 = Math.floor(h * 0.75);
      const step = 2;
      for (let y = y0; y < y1; y += step) {
        for (let x = x0; x < x1; x += step) {
          if (data[(y * w + x) * 4 + 3] < 235) lowAlpha++;
        }
      }
      return lowAlpha >= 80;
    }

    function drawCameraWithFrame(c, cameraSource, cw, ch) {
      if (overlayFailed || !overlayImg.naturalWidth) {
        c.setTransform(1, 0, 0, 1, 0, 0);
        c.globalAlpha = 1;
        c.globalCompositeOperation = "source-over";
        c.fillStyle = "#000000";
        c.fillRect(0, 0, cw, ch);
        drawSourceCoverInRect(c, cameraSource, 0, 0, cw, ch);
        return;
      }

      const ow = overlayImg.naturalWidth;
      const oh = overlayImg.naturalHeight;
      const box = computeContainRect(ow, oh, cw, ch);

      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalAlpha = 1;
      c.globalCompositeOperation = "source-over";
      c.fillStyle = "#000000";
      c.fillRect(0, 0, cw, ch);

      drawSourceCoverInRect(c, cameraSource, box.dx, box.dy, box.dw, box.dh);
      c.drawImage(overlayImg, 0, 0, ow, oh, box.dx, box.dy, box.dw, box.dh);

      if (!overlayHasTransparency) {
        const r = FALLBACK_PHOTO_HOLE_NORM;
        const hx = box.dx + r.x * box.dw;
        const hy = box.dy + r.y * box.dh;
        const hw = r.w * box.dw;
        const hh = r.h * box.dh;
        c.save();
        c.beginPath();
        c.rect(hx, hy, hw, hh);
        c.clip();
        drawSourceCoverInRect(c, cameraSource, hx, hy, hw, hh);
        c.restore();
      }
    }

    function compositeSize() {
      const ow = overlayImg.naturalWidth;
      const oh = overlayImg.naturalHeight;
      if (!overlayFailed && ow > 0 && oh > 0) return { w: ow, h: oh };
      return { w: OUT_W, h: OUT_H };
    }

    function syncLiveFrameOverlayVisibility() {
      if (!liveFrameOverlay) return;
      liveFrameOverlay.hidden = overlayFailed || !overlayImg.naturalWidth;
    }

    function clearGalleryAsset() {
      invalidateGalleryPreExport();
      if (liveUploadPreview) {
        liveUploadPreview.removeAttribute("src");
        liveUploadPreview.hidden = true;
      }
      const gv = galleryVideoEl;
      if (gv) {
        gv.pause();
        gv.removeAttribute("src");
        try {
          gv.load();
        } catch {
          /* ignore */
        }
      }
      const genc = galleryEncodeVideoEl;
      if (genc) {
        genc.pause();
        genc.removeAttribute("src");
        try {
          genc.load();
        } catch {
          /* ignore */
        }
      }
      if (galleryObjectUrl) {
        URL.revokeObjectURL(galleryObjectUrl);
        galleryObjectUrl = null;
      }
      if (video) video.hidden = false;
      refreshRecordAndExportButtons();
    }

    function galleryExportCanPreEncode() {
      if (typeof MediaRecorder === "undefined") return false;
      try {
        const c = galleryExportCanvas ?? ensureGalleryExportCanvas();
        return Boolean(c?.captureStream);
      } catch {
        return false;
      }
    }

    function syncGalleryVideoExportReadyUi() {
      const key = galleryObjectUrl || "";
      const isVideo = galleryMediaMode === "video";
      const preEncode = galleryExportCanPreEncode();
      const keyMatches = Boolean(key && galleryPreExportSrcKey === key);
      const pending = isVideo && preEncode && keyMatches && galleryPreExportPromise;
      const ready = isVideo && keyMatches && Boolean(galleryPreExportResult?.blob?.size);
      const canRetryOnDemand =
        isVideo &&
        preEncode &&
        keyMatches &&
        !galleryPreExportPromise &&
        !galleryPreExportResult?.blob?.size;

      const showMobileExport =
        isMobileLayout() &&
        isVideo &&
        galleryResultDialogExportVideo &&
        !galleryResultDialogExportVideo.hidden &&
        mobilePreviewOrigin === "gallery";

      if (showMobileExport && galleryResultDialogExportVideo) {
        const btn = galleryResultDialogExportVideo;
        if (exportingFramedVideo) {
          btn.disabled = true;
          btn.setAttribute("aria-busy", "true");
          btn.classList.add("gallery-result-dialog__export-video--waiting");
          btn.textContent = "Working…";
          if (galleryVideoExportHint) {
            galleryVideoExportHint.hidden = false;
            galleryVideoExportHint.textContent = "Hang on — finishing your download…";
          }
        } else if (pending) {
          btn.disabled = true;
          btn.setAttribute("aria-busy", "true");
          btn.classList.add("gallery-result-dialog__export-video--waiting");
          btn.textContent = "Download video";
          if (galleryVideoExportHint) {
            galleryVideoExportHint.hidden = false;
            galleryVideoExportHint.textContent =
              "Preparing your framed video — about as long as the clip. You can keep watching the preview.";
          }
        } else if (ready) {
          btn.disabled = false;
          btn.removeAttribute("aria-busy");
          btn.classList.remove("gallery-result-dialog__export-video--waiting");
          btn.textContent = "Download video";
          if (galleryVideoExportHint) {
            galleryVideoExportHint.hidden = false;
            galleryVideoExportHint.textContent = "Ready — tap below to save or share.";
          }
        } else if (!preEncode) {
          btn.disabled = false;
          btn.removeAttribute("aria-busy");
          btn.classList.remove("gallery-result-dialog__export-video--waiting");
          btn.textContent = "Download video";
          if (galleryVideoExportHint) {
            galleryVideoExportHint.hidden = false;
            galleryVideoExportHint.textContent =
              "Tap to export and download. Your device processes the file when you tap.";
          }
        } else if (canRetryOnDemand) {
          btn.disabled = false;
          btn.removeAttribute("aria-busy");
          btn.classList.remove("gallery-result-dialog__export-video--waiting");
          btn.textContent = "Download video";
          if (galleryVideoExportHint) {
            galleryVideoExportHint.hidden = false;
            galleryVideoExportHint.textContent =
              "Couldn’t prepare automatically — tap to export now (one play-through).";
          }
        } else {
          btn.disabled = true;
          btn.setAttribute("aria-busy", "true");
          btn.classList.add("gallery-result-dialog__export-video--waiting");
          btn.textContent = "Download video";
          if (galleryVideoExportHint) {
            galleryVideoExportHint.hidden = false;
            galleryVideoExportHint.textContent = "Getting your file ready…";
          }
        }
      } else if (galleryVideoExportHint) {
        galleryVideoExportHint.hidden = true;
        galleryVideoExportHint.textContent = "";
      }

      document.querySelectorAll('[data-action="export-video"]').forEach((el) => {
        if (!(el instanceof HTMLButtonElement)) return;
        if (!isVideo) {
          el.disabled = true;
          el.removeAttribute("aria-busy");
          el.classList.remove("btn-export-video--waiting");
          return;
        }
        const busy = exportingFramedVideo || isRecording;
        if (busy) {
          el.disabled = true;
          el.setAttribute("aria-busy", "true");
          el.classList.add("btn-export-video--waiting");
        } else if (pending) {
          el.disabled = true;
          el.setAttribute("aria-busy", "true");
          el.classList.add("btn-export-video--waiting");
        } else if (ready || !preEncode || canRetryOnDemand) {
          el.disabled = false;
          el.removeAttribute("aria-busy");
          el.classList.remove("btn-export-video--waiting");
        } else {
          el.disabled = true;
          el.setAttribute("aria-busy", "true");
          el.classList.add("btn-export-video--waiting");
        }
      });

      if (desktopGalleryExportHint) {
        if (!isVideo || isMobileLayout()) {
          desktopGalleryExportHint.hidden = true;
          desktopGalleryExportHint.textContent = "";
        } else if (exportingFramedVideo) {
          desktopGalleryExportHint.hidden = false;
          desktopGalleryExportHint.textContent = "Working — exporting framed video…";
        } else if (pending) {
          desktopGalleryExportHint.hidden = false;
          desktopGalleryExportHint.textContent =
            "Preparing framed video in the background — the button unlocks when it’s ready.";
        } else if (ready) {
          desktopGalleryExportHint.hidden = false;
          desktopGalleryExportHint.textContent = "Ready — Export framed video saves right away.";
        } else if (!preEncode) {
          desktopGalleryExportHint.hidden = false;
          desktopGalleryExportHint.textContent =
            "Tap Export when you’re ready; encoding runs when you tap.";
        } else if (canRetryOnDemand) {
          desktopGalleryExportHint.hidden = false;
          desktopGalleryExportHint.textContent =
            "Background prep didn’t finish — tap Export to encode manually.";
        } else {
          desktopGalleryExportHint.hidden = false;
          desktopGalleryExportHint.textContent = "Getting your file ready…";
        }
      }
    }

    /**
     * @param {'gallery' | 'capture'} origin
     */
    function openMobileGalleryPreview(origin) {
      if (!isMobileLayout() || !galleryResultDialog) return;
      if (!galleryResultPreviewImg && !galleryResultPreviewCanvas) return;
      const rc = document.getElementById("result");
      if (!rc) return;
      mobilePreviewOrigin = origin;

      const isGalleryVideo = galleryMediaMode === "video" && origin === "gallery" && galleryResultPreviewCanvas;

      if (isGalleryVideo) {
        if (galleryResultDialogDownload) galleryResultDialogDownload.hidden = true;
        if (galleryResultDialogExportVideo) {
          galleryResultDialogExportVideo.hidden = false;
          galleryResultDialogExportVideo.textContent = "Download video";
          galleryResultDialogExportVideo.classList.add("gallery-result-dialog__export-video--primary");
        }
        galleryResultDialog.showModal();
        startMobileGalleryDialogVideoPreview();
      } else {
        stopMobileGalleryDialogVideoPreview();
        composeToResult();
        if (galleryResultDialogDownload) galleryResultDialogDownload.hidden = false;
        if (galleryResultPreviewImg) {
          galleryResultPreviewImg.alt = "Framed photo preview";
          galleryResultPreviewImg.hidden = false;
          galleryResultPreviewImg.src = rc.toDataURL("image/jpeg", JPEG_QUALITY);
        }
        if (galleryResultDialogExportVideo) {
          galleryResultDialogExportVideo.classList.remove("gallery-result-dialog__export-video--primary");
          galleryResultDialogExportVideo.hidden = galleryMediaMode !== "video";
          galleryResultDialogExportVideo.textContent = "Download video";
        }
        galleryResultDialog.showModal();
      }

      if (origin === "capture") {
        setActionDisabled("capture", true);
        setActionDisabled("switch", true);
        setActionDisabled("stop", true);
      }
      refreshRecordAndExportButtons();
    }

    /**
     * @param {boolean} downloaded
     */
    function finishMobileGalleryFlow(downloaded) {
      const origin = mobilePreviewOrigin;
      mobilePreviewOrigin = null;

      if (origin === "framed-video") {
        const ctx = framedVideoContext;
        framedVideoContext = null;
        revokeMobilePendingFramedVideo();
        stopMobileGalleryDialogVideoPreview();
        resetDialogFooterButtons();
        if (galleryResultPreviewImg) {
          galleryResultPreviewImg.removeAttribute("src");
          galleryResultPreviewImg.alt = "";
        }
        if (galleryResultDialog?.open) galleryResultDialog.close();

        if (downloaded) {
          if (ctx === "camera") {
            disposeSource();
            stopTracks();
            if (video) video.srcObject = null;
            setCameraLive(false);
            setActionDisabled("start", false);
            setActionDisabled("stop", true);
            setActionDisabled("switch", true);
            setActionDisabled("capture", true);
            setActionDisabled("save", true);
            setStatus("Saved. Open camera when you’re ready.");
          } else {
            composeToResult();
            setStatus("Saved framed video.");
            setActionDisabled("start", false);
          }
        } else if (ctx === "camera") {
          setCameraLive(true);
          setActionDisabled("stop", false);
          setActionDisabled("switch", false);
          setActionDisabled("capture", false);
          setActionDisabled("save", true);
          const { w, h } = compositeSize();
          setStatus(`Ready — ${w}×${h}.`);
        } else {
          composeToResult();
          setStatus("Closed preview — tap Download video again to save, or pick another clip.");
          setActionDisabled("start", false);
        }
        refreshRecordAndExportButtons();
        return;
      }

      stopMobileGalleryDialogVideoPreview();

      if (galleryResultPreviewImg) {
        galleryResultPreviewImg.removeAttribute("src");
        galleryResultPreviewImg.alt = "";
      }
      if (galleryResultDialog?.open) galleryResultDialog.close();

      if (origin === "capture") {
        if (downloaded) {
          disposeSource();
          stopTracks();
          if (video) video.srcObject = null;
          setCameraLive(false);
          setActionDisabled("start", false);
          setActionDisabled("stop", true);
          setActionDisabled("switch", true);
          setActionDisabled("capture", true);
          setActionDisabled("save", true);
          setStatus("Saved. Open camera when you’re ready.");
        } else {
          disposeSource();
          setCameraLive(true);
          setActionDisabled("stop", false);
          setActionDisabled("switch", false);
          setActionDisabled("capture", false);
          setActionDisabled("save", true);
          const { w, h } = compositeSize();
          setStatus(`Ready — ${w}×${h}.`);
        }
        resetDialogFooterButtons();
        return;
      }

      disposeSource();
      setCameraLive(false);
      setActionDisabled("start", false);
      setActionDisabled("stop", true);
      setActionDisabled("switch", true);
      setActionDisabled("capture", true);
      setActionDisabled("save", true);
      setStatus(
        downloaded
          ? "Saved. Open camera when you’re ready."
          : "Gallery closed — open camera or pick another photo."
      );
      resetDialogFooterButtons();
      refreshRecordAndExportButtons();
    }

    function applyGalleryFile(file) {
      if (!file || (!file.type.startsWith("image/") && !file.type.startsWith("video/"))) {
        setStatus("Please choose an image or video file.", true);
        return;
      }

      if (galleryResultDialog?.open) {
        revokeMobilePendingFramedVideo();
        framedVideoContext = null;
        mobilePreviewOrigin = null;
        stopMobileGalleryDialogVideoPreview();
        resetDialogFooterButtons();
        galleryResultPreviewImg?.removeAttribute("src");
        galleryResultDialog.close();
      }

      stopTracks();
      if (video) video.srcObject = null;

      sourceCanvas = null;
      clearGalleryAsset();

      galleryObjectUrl = URL.createObjectURL(file);

      if (file.type.startsWith("video/")) {
        const gv = ensureGalleryVideoEl();
        gv.src = galleryObjectUrl;

        gv.onloadeddata = () => {
          gv.onloadeddata = null;
          gv.pause();
          gv.currentTime = 0;
          void waitVideoSeeked(gv).then(() => {
            setGalleryMediaMode("video");
            if (video) video.hidden = true;
            if (liveUploadPreview) liveUploadPreview.hidden = true;

            setCameraLive(false);
            setActionDisabled("stop", true);
            setActionDisabled("switch", true);
            setActionDisabled("capture", true);
            setActionDisabled("start", false);
            setActionDisabled("save", isMobileLayout());

            composeToResult();
            refreshRecordAndExportButtons();

            void startGalleryPreExportIfNeeded();

            const dur = Number.isFinite(gv.duration) ? gv.duration : 0;
            if (isMobileLayout()) {
              setStatus(
                dur > 0 ? `Preview — ${dur.toFixed(1)}s clip.` : "Preview your framed video.",
                false
              );
              openMobileGalleryPreview("gallery");
            } else {
              const { w, h } = compositeSize();
              setStatus(
                overlayFailed
                  ? "Video loaded — composite without frame."
                  : `Video loaded — ${w}×${h}.`,
                overlayFailed
              );
            }
            syncGalleryVideoExportReadyUi();

            logCampaignEvent("gallery_video_upload", {
              ...analyticsLayoutParam(),
              duration_sec: dur > 0 ? Math.round(dur * 10) / 10 : 0,
            });
          });
        };

        gv.onerror = () => {
          setStatus("Could not load that video.", true);
          logCampaignEvent("gallery_video_load_error", analyticsLayoutParam());
          clearGalleryAsset();
          setGalleryMediaMode(null);
          sourceCanvas = null;
          refreshRecordAndExportButtons();
        };

        return;
      }

      const img = new Image();

      img.onload = () => {
        const iw = img.naturalWidth;
        const ih = img.naturalHeight;
        if (!iw || !ih) {
          setStatus("That image has no usable size.", true);
          clearGalleryAsset();
          setGalleryMediaMode(null);
          return;
        }

        setGalleryMediaMode("image");

        logCampaignEvent("gallery_image_upload", {
          ...analyticsLayoutParam(),
          width: iw,
          height: ih,
        });

        if (!sourceCanvas) sourceCanvas = document.createElement("canvas");
        sourceCanvas.width = iw;
        sourceCanvas.height = ih;
        const sctx = sourceCanvas.getContext("2d");
        if (!sctx) return;
        sctx.drawImage(img, 0, 0);

        if (liveUploadPreview) {
          liveUploadPreview.src = galleryObjectUrl;
          liveUploadPreview.hidden = false;
        }
        if (video) video.hidden = true;

        setCameraLive(false);
        setActionDisabled("stop", true);
        setActionDisabled("switch", true);
        setActionDisabled("capture", true);
        setActionDisabled("start", false);
        setActionDisabled("save", isMobileLayout());

        composeToResult();
        refreshRecordAndExportButtons();

        if (isMobileLayout()) {
          setStatus("Preview your framed photo.", false);
          openMobileGalleryPreview("gallery");
        } else {
          const { w, h } = compositeSize();
          setStatus(
            overlayFailed ? "Photo loaded — composite without frame." : `Photo loaded — ${w}×${h} composite ready.`,
            overlayFailed
          );
        }
      };

      img.onerror = () => {
        setStatus("Could not load that image.", true);
        logCampaignEvent("gallery_image_load_error", analyticsLayoutParam());
        clearGalleryAsset();
        sourceCanvas = null;
        setGalleryMediaMode(null);
        refreshRecordAndExportButtons();
      };

      img.src = galleryObjectUrl;
    }

    const overlayImg = new Image();

    if (liveFrameOverlay) liveFrameOverlay.src = OVERLAY_SRC;

    overlayImg.onload = () => {
      overlayFailed = false;
      overlayHasTransparency = checkOverlayTransparency(overlayImg);
      syncLiveFrameOverlayVisibility();

      const hint = overlayHasTransparency
        ? "Frame on top; camera fills the frame area."
        : "Little PNG alpha — a fixed hole shows the camera.";

      if (getActiveComposeSource()) {
        composeToResult();
        const { w, h } = compositeSize();
        setStatus(`${hint} Ready — ${w}×${h} JPEG.`, !overlayHasTransparency);
      } else if (stream) {
        setStatus(`${hint}`, !overlayHasTransparency);
      }
    };
    overlayImg.onerror = () => {
      overlayFailed = true;
      overlayHasTransparency = false;
      syncLiveFrameOverlayVisibility();
      logCampaignEvent("overlay_error", analyticsLayoutParam());
      setStatus("Could not load overlay-frame.png.", true);
      if (getActiveComposeSource()) composeToResult();
    };
    overlayImg.src = OVERLAY_SRC;

    function composeToResult() {
      const src = getActiveComposeSource();
      if (!src) return;
      composeFromMediaSource(src, false);
    }

    function disposeSource() {
      clearGalleryAsset();
      sourceCanvas = null;
      setGalleryMediaMode(null);
      setActionDisabled("save", true);
      const rc = document.getElementById("result");
      if (!rc) return;
      const { w, h } = compositeSize();
      rc.width = w;
      rc.height = h;
      const rctx = rc.getContext("2d", { alpha: true });
      if (rctx) {
        rctx.fillStyle = "#0a0c10";
        rctx.fillRect(0, 0, w, h);
      }
      refreshRecordAndExportButtons();
    }

    function startCameraRecording() {
      const rc = document.getElementById("result");
      const v = video;
      if (!rc || !v || !stream || typeof MediaRecorder === "undefined") {
        setStatus("Framed video recording is not supported in this browser.", true);
        return;
      }
      if (v.readyState < 2 || !v.videoWidth) {
        setStatus("Wait for the camera preview to be ready.", true);
        return;
      }

      const vs = captureCanvasStreamForRecord(rc);
      if (!vs) {
        setStatus("Could not capture canvas stream for recording.", true);
        return;
      }

      const mime = pickRecorderMime();
      composeFromMediaSource(v, true);
      cameraRecordChunks = [];
      const mr = new MediaRecorder(
        vs,
        mime
          ? { mimeType: mime, videoBitsPerSecond: RECORD_VIDEO_BITRATE }
          : { videoBitsPerSecond: RECORD_VIDEO_BITRATE }
      );
      const resolvedMime = mime || "video/mp4";
      mr.ondataavailable = (e) => {
        if (e.data.size) cameraRecordChunks.push(e.data);
      };
      mr.onstop = () => {
        const outType = mr.mimeType || resolvedMime;
        const ext = outType.includes("mp4") ? "mp4" : "webm";
        const blob = new Blob(cameraRecordChunks, { type: outType });
        cameraRecordChunks = [];
        cameraMediaRecorder = null;

        logCampaignEvent("camera_record_complete", {
          ...analyticsLayoutParam(),
          format: String(ext),
          size_bytes: blob.size,
        });

        if (isMobileLayout()) {
          offerMobileFramedVideoPreview(blob, outType, ext, "camera");
        } else {
          downloadVideoBlob(blob, ext, { video_source: "camera_record" });
          setStatus(`Saved framed recording (.${ext}).`);
          setActionDisabled("capture", false);
          setActionDisabled("switch", false);
        }
        refreshRecordAndExportButtons();
      };
      cameraMediaRecorder = mr;
      isRecording = true;
      setActionDisabled("capture", true);
      setActionDisabled("switch", true);
      refreshRecordAndExportButtons();
      setStatus("Recording framed video… tap Stop when done.");

      logCampaignEvent("camera_record_start", { ...analyticsLayoutParam() });

      cancelCameraComposeLoop?.();
      cancelCameraComposeLoop = startVideoComposeLoop(
        v,
        () => isRecording && !!stream && !!video,
        () => {
          composeFromMediaSource(v, true);
        }
      );
      mr.start(100);
    }

    function stopCameraRecording() {
      if (!isRecording) return;
      isRecording = false;
      cancelCameraComposeLoop?.();
      cancelCameraComposeLoop = null;
      if (cameraMediaRecorder?.state === "recording") {
        try {
          cameraMediaRecorder.requestData();
        } catch {
          /* ignore */
        }
      }
      if (cameraMediaRecorder && cameraMediaRecorder.state !== "inactive") {
        cameraMediaRecorder.stop();
      } else {
        cameraMediaRecorder = null;
        cameraRecordChunks = [];
        refreshRecordAndExportButtons();
      }
    }

    function toggleCameraRecording() {
      if (isRecording) {
        stopCameraRecording();
        return;
      }
      startCameraRecording();
    }

    function waitVideoElementCanDecode(el) {
      return new Promise((resolve) => {
        if (el.readyState >= 2) {
          resolve();
          return;
        }
        el.addEventListener("loadeddata", () => resolve(), { once: true });
        el.addEventListener("error", () => resolve(), { once: true });
      });
    }

    function startGalleryPreExportIfNeeded() {
      const key = galleryObjectUrl || "";
      if (!key || galleryMediaMode !== "video") return;
      if (typeof MediaRecorder === "undefined") return;
      const encCanvas = ensureGalleryExportCanvas();
      if (!encCanvas.captureStream) return;

      if (galleryPreExportSrcKey === key && galleryPreExportResult?.blob?.size) return;
      if (galleryPreExportSrcKey === key && galleryPreExportPromise) return;

      galleryPreExportSrcKey = key;
      const runId = galleryPreExportRunId;
      const enc = ensureGalleryEncodeVideoEl();
      enc.src = key;

      galleryPreExportPromise = (async () => {
        await waitVideoElementCanDecode(enc);
        if (runId !== galleryPreExportRunId) return null;
        if (!enc.videoWidth) {
          await new Promise((resolve) => {
            enc.addEventListener("loadeddata", () => resolve(), { once: true });
            enc.addEventListener("error", () => resolve(), { once: true });
          });
        }
        if (runId !== galleryPreExportRunId) return null;
        const out = await encodeGalleryFramedVideoFromVideoElement(enc, {
          isAborted: () => runId !== galleryPreExportRunId,
        });
        if (runId !== galleryPreExportRunId || !out?.blob?.size) return null;
        galleryPreExportResult = out;
        galleryPreExportPromise = null;
        syncGalleryVideoExportReadyUi();
        return out;
      })().catch((e) => {
        console.error(e);
        if (runId === galleryPreExportRunId) galleryPreExportPromise = null;
        syncGalleryVideoExportReadyUi();
        return null;
      });

      syncGalleryVideoExportReadyUi();
    }

    /**
     * Encodes framed gallery clip to a blob using an off-screen canvas (visible `#result` unchanged).
     * @param {HTMLVideoElement} videoEl
     * @param {{ isAborted?: () => boolean }} [opts]
     * @returns {Promise<{ blob: Blob; outType: string; ext: string } | null>}
     */
    async function encodeGalleryFramedVideoFromVideoElement(videoEl, opts = {}) {
      const { isAborted = () => false } = opts;
      const rc = ensureGalleryExportCanvas();
      if (!rc.captureStream) return null;

      /** @type {ReturnType<typeof setTimeout> | 0} */
      let exportSafetyTimer = 0;
      try {
        videoEl.loop = false;
        videoEl.pause();
        videoEl.currentTime = 0;
        await waitVideoSeeked(videoEl);
        if (!videoEl.videoWidth) {
          await new Promise((resolve) => {
            const done = () => resolve();
            if (videoEl.videoWidth) {
              done();
              return;
            }
            videoEl.addEventListener("loadeddata", done, { once: true });
            videoEl.addEventListener("error", done, { once: true });
          });
        }
        if (isAborted()) return null;

        prepareGalleryVideoLayoutForExport(videoEl);

        const vs = captureCanvasStreamForRecord(rc, GALLERY_EXPORT_CAPTURE_FPS);
        if (!vs) {
          restoreGalleryVideoHiddenLayout(videoEl);
          return null;
        }

        const mime = pickRecorderMime();
        composeOntoCanvas(rc, videoEl, true);
        const chunks = [];
        const mr = new MediaRecorder(
          vs,
          mime
            ? { mimeType: mime, videoBitsPerSecond: RECORD_VIDEO_BITRATE }
            : { videoBitsPerSecond: RECORD_VIDEO_BITRATE }
        );
        const resolvedMime = mime || "video/mp4";
        mr.ondataavailable = (e) => {
          if (e.data.size) chunks.push(e.data);
        };

        const recorderStopped = new Promise((resolve, reject) => {
          mr.onstop = () => resolve();
          mr.onerror = () => reject(new Error("Recorder error"));
        });

        const timelineEnd = getVideoTimelineEnd(videoEl);
        const maxWaitMs = Math.min(
          600_000,
          (timelineEnd > 0 ? timelineEnd + 45 : 120) * 1000
        );
        const deadline = Date.now() + maxWaitMs;

        await videoEl.play();
        if (isAborted()) {
          try {
            videoEl.pause();
          } catch {
            /* ignore */
          }
          restoreGalleryVideoHiddenLayout(videoEl);
          return null;
        }

        cancelExportComposeLoop?.();
        let rafExportId = 0;
        const composeMinMs = 1000 / GALLERY_EXPORT_CAPTURE_FPS;
        let lastComposePerf = performance.now();
        let postEndComposesRemaining = 0;

        function cancelExportPump() {
          if (rafExportId) {
            cancelAnimationFrame(rafExportId);
            rafExportId = 0;
          }
        }
        cancelExportComposeLoop = cancelExportPump;

        function finishExportRecord() {
          cancelExportPump();
          try {
            if (mr.state === "recording") mr.requestData();
          } catch {
            /* ignore */
          }
          try {
            mr.stop();
          } catch {
            /* ignore */
          }
        }

        function pumpExportFrame() {
          if (isAborted()) {
            if (mr.state === "recording") finishExportRecord();
            return;
          }
          if (mr.state !== "recording") return;

          if (Date.now() > deadline) {
            finishExportRecord();
            return;
          }

          const now = performance.now();
          if (videoEl.ended) {
            composeOntoCanvas(rc, videoEl, true);
            if (postEndComposesRemaining === 0) postEndComposesRemaining = 6;
            postEndComposesRemaining--;
            if (postEndComposesRemaining <= 0) {
              finishExportRecord();
              return;
            }
          } else if (now - lastComposePerf >= composeMinMs - 0.25) {
            lastComposePerf = now;
            composeOntoCanvas(rc, videoEl, true);
          }

          rafExportId = requestAnimationFrame(pumpExportFrame);
        }

        mr.start(100);
        rafExportId = requestAnimationFrame(pumpExportFrame);

        exportSafetyTimer = window.setTimeout(() => {
          finishExportRecord();
        }, Math.min(720_000, maxWaitMs + 30_000));

        await recorderStopped;

        if (isAborted()) return null;

        const outType = mr.mimeType || resolvedMime;
        const ext = outType.includes("mp4") ? "mp4" : "webm";
        const blob = new Blob(chunks, { type: outType });
        if (!blob.size) return null;

        return { blob, outType, ext };
      } catch (e) {
        console.error(e);
        return null;
      } finally {
        if (exportSafetyTimer) {
          clearTimeout(exportSafetyTimer);
        }
        cancelExportComposeLoop?.();
        cancelExportComposeLoop = null;
        restoreGalleryVideoHiddenLayout(videoEl);
        try {
          videoEl.pause();
          videoEl.currentTime = 0;
        } catch {
          /* ignore */
        }
        await waitVideoSeeked(videoEl);
      }
    }

    function deliverGalleryExportBlob(bundle) {
      if (!bundle?.blob?.size) return;
      const { blob, outType, ext } = bundle;
      if (isMobileLayout()) {
        stopMobileGalleryDialogVideoPreview();
        offerMobileFramedVideoPreview(blob, outType, ext, "gallery-export");
      } else {
        downloadVideoBlob(blob, ext, { video_source: "gallery_export" });
        setStatus(`Downloaded framed video (.${ext}).`);
      }
    }

    async function finishGalleryExportUiAfterEncode() {
      exportingFramedVideo = false;
      const gv = galleryVideoEl;
      if (gv) gv.pause();
      setActionDisabled("start", false);
      setActionDisabled("upload", false);
      if (galleryMediaMode === "video") setActionDisabled("save", true);
      else if (galleryMediaMode === "image") setActionDisabled("save", isMobileLayout());
      else setActionDisabled("save", true);
      refreshRecordAndExportButtons();
    }

    async function exportFramedVideoFromGallery() {
      const gv = galleryVideoEl;
      const key = galleryObjectUrl || "";
      if (galleryMediaMode !== "video" || !gv?.src || exportingFramedVideo) return;
      if (typeof MediaRecorder === "undefined" || !ensureGalleryExportCanvas().captureStream) {
        setStatus("Video export is not supported in this browser.", true);
        logCampaignEvent("gallery_framed_export_fail", {
          ...analyticsLayoutParam(),
          reason: "not_supported",
        });
        return;
      }

      let exportPath = "full_encode";
      if (key && galleryPreExportSrcKey === key && galleryPreExportResult?.blob?.size) {
        exportPath = "precache_hit";
      } else if (key && galleryPreExportSrcKey === key && galleryPreExportPromise) {
        exportPath = "wait_precache";
      }
      logCampaignEvent("gallery_framed_export", {
        ...analyticsLayoutParam(),
        path: exportPath,
      });

      if (key && galleryPreExportSrcKey === key && galleryPreExportResult?.blob?.size) {
        exportingFramedVideo = true;
        refreshRecordAndExportButtons();
        try {
          deliverGalleryExportBlob(galleryPreExportResult);
          if (!isMobileLayout()) composeToResult();
        } finally {
          exportingFramedVideo = false;
          refreshRecordAndExportButtons();
        }
        return;
      }

      if (key && galleryPreExportSrcKey === key && galleryPreExportPromise) {
        exportingFramedVideo = true;
        stopMobileGalleryDialogVideoPreview();
        setActionDisabled("start", true);
        setActionDisabled("upload", true);
        setActionDisabled("save", true);
        setActionDisabled("record-toggle", true);
        setActionDisabled("export-video", true);
        refreshRecordAndExportButtons();
        setStatus("Almost ready…");
        try {
          const out = await galleryPreExportPromise;
          if (out?.blob?.size && key === galleryPreExportSrcKey) {
            galleryPreExportResult = out;
            deliverGalleryExportBlob(out);
          } else {
            setStatus("Exporting framed video (playing through once)…");
            const manual = await encodeGalleryFramedVideoFromVideoElement(gv, {
              isAborted: () => !exportingFramedVideo,
            });
            if (manual?.blob?.size && key === galleryPreExportSrcKey) galleryPreExportResult = manual;
            if (manual?.blob?.size) {
              deliverGalleryExportBlob(manual);
            } else {
              setStatus("Could not export framed video.", true);
              logCampaignEvent("gallery_framed_export_fail", analyticsLayoutParam());
            }
          }
          if (!isMobileLayout()) composeToResult();
        } catch (e) {
          console.error(e);
          setStatus("Could not export framed video.", true);
          logCampaignEvent("gallery_framed_export_fail", {
            ...analyticsLayoutParam(),
            reason: "exception",
          });
        } finally {
          await finishGalleryExportUiAfterEncode();
        }
        return;
      }

      exportingFramedVideo = true;
      stopMobileGalleryDialogVideoPreview();
      setActionDisabled("start", true);
      setActionDisabled("upload", true);
      setActionDisabled("save", true);
      setActionDisabled("record-toggle", true);
      setActionDisabled("export-video", true);
      refreshRecordAndExportButtons();
      setStatus("Exporting framed video (playing through once)…");

      try {
        const manual = await encodeGalleryFramedVideoFromVideoElement(gv, {
          isAborted: () => !exportingFramedVideo,
        });
        if (manual?.blob?.size && key === galleryPreExportSrcKey) galleryPreExportResult = manual;
        if (manual?.blob?.size) {
          deliverGalleryExportBlob(manual);
        } else {
          setStatus("Could not export framed video.", true);
          logCampaignEvent("gallery_framed_export_fail", analyticsLayoutParam());
        }
        if (!isMobileLayout()) composeToResult();
      } catch (e) {
        console.error(e);
        setStatus("Could not export framed video.", true);
        logCampaignEvent("gallery_framed_export_fail", {
          ...analyticsLayoutParam(),
          reason: "exception",
        });
      } finally {
        await finishGalleryExportUiAfterEncode();
      }
    }

    /**
     * Prefer modern API (works with LAN IPs over https://). Falls back to legacy when
     * `mediaDevices` is missing (some older WebViews over http://).
     */
    function getUserMediaCompat(constraints) {
      if (navigator.mediaDevices?.getUserMedia) {
        return navigator.mediaDevices.getUserMedia(constraints);
      }
      const legacy =
        navigator.getUserMedia ||
        navigator.webkitGetUserMedia ||
        navigator.mozGetUserMedia ||
        navigator.msGetUserMedia;
      if (!legacy) {
        return Promise.reject(
          new Error(
            "Camera API unavailable. Use a browser that supports getUserMedia, or https:// for this host."
          )
        );
      }
      return new Promise((resolve, reject) => {
        legacy.call(navigator, constraints, resolve, reject);
      });
    }

    async function openCameraStream(mode) {
      const attempts = [
        {
          video: {
            facingMode: { ideal: mode },
            width: { ideal: 1920, min: 320 },
            height: { ideal: 1080, min: 240 },
          },
          audio: false,
        },
        {
          video: {
            facingMode: { ideal: mode },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        },
        { video: { facingMode: mode }, audio: false },
        { video: true, audio: false },
      ];

      let lastErr = /** @type {unknown} */ (null);
      for (const constraints of attempts) {
        try {
          return await getUserMediaCompat(constraints);
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    }

    function waitForVideoFrames(el, timeoutMs = 15000) {
      if (el.readyState >= 2) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const t = window.setTimeout(() => {
          reject(new Error("Video did not become ready in time."));
        }, timeoutMs);
        const done = () => {
          window.clearTimeout(t);
          resolve();
        };
        el.addEventListener("loadeddata", done, { once: true });
        el.addEventListener(
          "error",
          () => {
            window.clearTimeout(t);
            reject(el.error || new Error("Video failed to load."));
          },
          { once: true }
        );
      });
    }

    async function startCamera() {
      if (!video || !document.querySelector('[data-action="start"]')) return;

      setStatus("");
      stopTracks();
      disposeSource();

      setActionDisabled("start", true);
      try {
        stream = await openCameraStream(facingMode);
        video.srcObject = stream;
        video.setAttribute("playsinline", "");
        video.setAttribute("webkit-playsinline", "");
        video.playsInline = true;
        video.muted = true;

        await waitForVideoFrames(video);
        const playAttempt = video.play();
        if (playAttempt !== undefined) await playAttempt;

        setActionDisabled("stop", false);
        setActionDisabled("switch", false);
        setActionDisabled("capture", false);
        setActionDisabled("start", true);
        setCameraLive(true);
        const { w: ow, h: oh } = compositeSize();
        setStatus(`Ready — ${ow}×${oh}.`);
        logCampaignEvent("camera_stream_start", {
          ...analyticsLayoutParam(),
          facing_mode: facingMode,
        });
        refreshRecordAndExportButtons();
      } catch (err) {
        console.error(err);
        stopTracks();
        if (video) video.srcObject = null;
        const name = err instanceof Error ? err.name : "";
        logCampaignEvent("camera_stream_error", {
          ...analyticsLayoutParam(),
          error_name: name || "unknown",
        });
        const nonSecureTip = !window.isSecureContext
          ? " For phone or LAN IP access, serve the app over https://."
          : "";
        const msg =
          name === "SecurityError" || name === "NotSupportedError"
            ? "Camera is blocked for this page. Use https:// (including https://YOUR_IP) so the browser allows the camera."
            : name === "NotAllowedError" || name === "PermissionDeniedError"
              ? "Allow camera access in the browser."
              : name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError"
                ? "No camera found or constraints failed."
                : err instanceof Error && err.message === "Video did not become ready in time."
                  ? "Video did not become ready — try again."
                  : err instanceof Error &&
                      /getUserMedia|not available|Camera API/i.test(err.message)
                    ? err.message + nonSecureTip
                    : "Could not open the camera." + nonSecureTip;
        setStatus(msg, true);
        setActionDisabled("stop", true);
        setActionDisabled("switch", true);
        setActionDisabled("capture", true);
        setActionDisabled("start", false);
        setCameraLive(false);
        refreshRecordAndExportButtons();
      }
    }

    function stopTracks() {
      if (stream) {
        stream.getTracks().forEach((t) => t.stop());
        stream = null;
      }
      if (video) video.srcObject = null;
    }

    function stopCamera() {
      if (isRecording && cameraMediaRecorder) {
        isRecording = false;
        cancelCameraComposeLoop?.();
        cancelCameraComposeLoop = null;
        const mr = cameraMediaRecorder;
        mr.addEventListener(
          "stop",
          () => {
            cameraMediaRecorder = null;
            cameraRecordChunks = [];
            stopTracks();
            setCameraLive(false);
            setActionDisabled("stop", true);
            setActionDisabled("switch", true);
            setActionDisabled("capture", true);
            setActionDisabled("start", false);
            logCampaignEvent("camera_stream_stop", analyticsLayoutParam());
            setStatus("Camera closed.");
            refreshRecordAndExportButtons();
          },
          { once: true }
        );
        mr.stop();
        return;
      }
      stopCameraRecording();
      stopTracks();
      setCameraLive(false);
      setActionDisabled("stop", true);
      setActionDisabled("switch", true);
      setActionDisabled("capture", true);
      setActionDisabled("start", false);
      logCampaignEvent("camera_stream_stop", analyticsLayoutParam());
      setStatus("Camera closed.");
      refreshRecordAndExportButtons();
    }

    async function switchCamera() {
      if (isRecording) return;
      if (!stream || !video) return;
      const previous = facingMode;
      const next = previous === "user" ? "environment" : "user";
      stopTracks();
      try {
        stream = await openCameraStream(next);
        facingMode = next;
        video.srcObject = stream;
        video.setAttribute("playsinline", "");
        video.setAttribute("webkit-playsinline", "");
        video.playsInline = true;
        video.muted = true;
        await waitForVideoFrames(video);
        const p = video.play();
        if (p !== undefined) await p;
        logCampaignEvent("camera_facing_switch", {
          ...analyticsLayoutParam(),
          facing_mode: facingMode,
        });
        setStatus("Camera switched.");
      } catch (err) {
        console.error(err);
        try {
          stream = await openCameraStream(previous);
          facingMode = previous;
          video.srcObject = stream;
          await video.play();
          setStatus("That camera is not available.", true);
        } catch (err2) {
          console.error(err2);
          setActionDisabled("stop", true);
          setActionDisabled("switch", true);
          setActionDisabled("capture", true);
          setActionDisabled("start", false);
          setStatus("Could not restore camera. Tap Open camera.", true);
          setCameraLive(false);
        }
      }
      if (stream) setCameraLive(true);
      refreshRecordAndExportButtons();
    }

    function capturePhoto() {
      if (isRecording) return;
      if (!video || !stream || video.readyState < 2) {
        setStatus("Wait for the video to be ready.", true);
        return;
      }
      const w = video.videoWidth;
      const h = video.videoHeight;
      if (!w || !h) {
        setStatus("Video has no dimensions yet.", true);
        return;
      }

      if (!sourceCanvas) {
        sourceCanvas = document.createElement("canvas");
      }
      sourceCanvas.width = w;
      sourceCanvas.height = h;
      const sctx = sourceCanvas.getContext("2d");
      if (!sctx) return;
      sctx.drawImage(video, 0, 0, w, h);

      setActionDisabled("save", isMobileLayout());
      composeToResult();

      const rcap = document.getElementById("result");
      const pw = rcap ? rcap.width : compositeSize().w;
      const ph = rcap ? rcap.height : compositeSize().h;

      logCampaignEvent("camera_photo_capture", {
        ...analyticsLayoutParam(),
        facing_mode: facingMode,
      });

      if (isMobileLayout()) {
        setStatus("Preview your photo — download or close.", false);
        openMobileGalleryPreview("capture");
      } else {
        setStatus(
          overlayFailed ? "Captured without frame." : `Captured — ${pw}×${ph}. Use Save to download.`,
          overlayFailed
        );
      }
    }

    /**
     * @param {() => void} [onComplete] Runs after a successful file download trigger (e.g. gallery dialog).
     */
    function savePhoto(onComplete) {
      const rc = document.getElementById("result");
      if (!rc) return;
      const src = getActiveComposeSource();
      if (!src) return;
      composeFromMediaSource(src, false);

      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const pw = rc.width;
      const ph = rc.height;
      const name = `campaign-${pw}x${ph}-${stamp}.jpg`;

      rc.toBlob(
        (blob) => {
          if (!blob) {
            setStatus("Could not create image file.", true);
            return;
          }
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = name;
          a.click();
          URL.revokeObjectURL(url);
          setStatus(`Downloaded ${name}`);
          logCampaignEvent("photo_download", {
            ...analyticsLayoutParam(),
            photo_source: inferPhotoDownloadSource(),
          });
          onComplete?.();
        },
        "image/jpeg",
        JPEG_QUALITY
      );
    }

    shell?.addEventListener("click", (e) => {
      const t = e.target instanceof Element ? e.target.closest("[data-action]") : null;
      if (!t || !(t instanceof HTMLButtonElement) || t.disabled) return;
      const a = t.dataset.action;
      if (a === "start") void startCamera();
      else if (a === "stop") {
        stopCamera();
        disposeSource();
      } else if (a === "switch") void switchCamera();
      else if (a === "capture") capturePhoto();
      else if (a === "save") savePhoto();
      else if (a === "upload") galleryInput?.click();
      else if (a === "record-toggle") toggleCameraRecording();
      else if (a === "export-video") void exportFramedVideoFromGallery();
    });

    galleryInput?.addEventListener("change", () => {
      const f = galleryInput.files?.[0];
      galleryInput.value = "";
      if (f) applyGalleryFile(f);
    });

    galleryResultDialogClose?.addEventListener("click", () => {
      if (exportingFramedVideo) return;
      finishMobileGalleryFlow(false);
    });
    galleryResultDialogDownload?.addEventListener("click", () => {
      if (mobilePendingFramedVideo) {
        void (async () => {
          const videoSource =
            framedVideoContext === "camera"
              ? "camera_record"
              : framedVideoContext === "gallery-export"
                ? "gallery_export"
                : "unknown";
          const ok = await saveFramedVideoWithUserGesture(
            mobilePendingFramedVideo.blob,
            mobilePendingFramedVideo.ext,
            { video_source: videoSource }
          );
          if (ok) finishMobileGalleryFlow(true);
        })();
        return;
      }
      savePhoto(() => {
        finishMobileGalleryFlow(true);
      });
    });
    galleryResultDialogExportVideo?.addEventListener("click", () => {
      if (exportingFramedVideo) return;
      if (galleryResultDialogExportVideo?.disabled) return;
      stopMobileGalleryDialogVideoPreview();
      if (galleryResultPreviewImg) {
        galleryResultPreviewImg.removeAttribute("src");
        galleryResultPreviewImg.alt = "";
      }
      void (async () => {
        try {
          await exportFramedVideoFromGallery();
        } finally {
          syncGalleryVideoExportReadyUi();
        }
      })();
    });
    galleryResultDialog?.addEventListener("click", (e) => {
      if (exportingFramedVideo) return;
      if (e.target === galleryResultDialog) finishMobileGalleryFlow(false);
    });
    galleryResultDialog?.addEventListener("cancel", (e) => {
      e.preventDefault();
      if (exportingFramedVideo) return;
      finishMobileGalleryFlow(false);
    });

    if (!video || !document.querySelector('[data-action="start"]') || !document.getElementById("result")) {
      setStatus("Page failed to initialize.", true);
    } else {
      showInsecureContextHelp();
      logCampaignEvent("campaign_app_open", analyticsLayoutParam());
    }
    setCameraLive(false);
    setGalleryMediaMode(null);
    refreshRecordAndExportButtons();

    /** Mobile Chrome only allows the camera on https:// or localhost (not http:// + LAN IP). */
    function showInsecureContextHelp() {
      if (window.isSecureContext) return;
      if (window.location.protocol === "file:") {
        setStatus(
          "Camera will not work from a file:// page. In the camera-filter-app folder run: npm install && npm start — then open the https:// URL shown in the terminal.",
          true
        );
        return;
      }
      const host = window.location.hostname;
      if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return;
      setStatus(
        "Use https:// for this site on your phone (http:// + Wi‑Fi IP is blocked by Chrome). On your PC run: npm install && npm start in camera-filter-app, then open https://YOUR_PC_IP:8443 and tap Advanced → continue past the certificate warning.",
        true
      );
    }

    window.addEventListener("beforeunload", stopTracks);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initApp, { once: true });
  } else {
    initApp();
  }
})();
