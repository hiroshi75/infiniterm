import { Terminal } from 'xterm';

// ---- Color scale (fire heatmap) ----

const COLOR_SCALE: { score: number; color: [number, number, number] }[] = [
  { score: 0.00, color: [180,  28,  10] },  // 深紅 — 変化なし
  { score: 0.25, color: [220,  70,   8] },  // 赤橙
  { score: 0.50, color: [255, 190,   0] },  // 黄 — 普通
  { score: 0.75, color: [140, 100,   0] },  // 暗い黄
  { score: 1.00, color: [ 55,  32,   0] },  // 非常に暗い黄/焦げ茶 — 激しく更新中
];

function computeScore(lastUpdatedAt: number, now: number, decayMs: number): number {
  if (lastUpdatedAt === 0) return 0; // 未更新 = 最大輝度
  const age = now - lastUpdatedAt;
  return Math.max(0, Math.min(1, Math.exp((-age / decayMs) * 3)));
}

function scoreToColor(score: number): [number, number, number] {
  for (let i = 0; i < COLOR_SCALE.length - 1; i++) {
    const lo = COLOR_SCALE[i], hi = COLOR_SCALE[i + 1];
    if (score >= lo.score && score <= hi.score) {
      const t = (score - lo.score) / (hi.score - lo.score);
      return [
        Math.round(lo.color[0] + (hi.color[0] - lo.color[0]) * t),
        Math.round(lo.color[1] + (hi.color[1] - lo.color[1]) * t),
        Math.round(lo.color[2] + (hi.color[2] - lo.color[2]) * t),
      ];
    }
  }
  return [...COLOR_SCALE[COLOR_SCALE.length - 1].color] as [number, number, number];
}

// ---- Public interface ----

export interface MinimapOptions {
  decayMs?: number;
  targetFps?: number;
}

export class HorizontalMinimap {
  private canvas: HTMLCanvasElement;
  private overlay: HTMLElement;
  private scrollThumb: HTMLElement;
  private ctx: CanvasRenderingContext2D;

  private decayMs: number;
  private frameMs: number;

  // Connected terminal state
  private term: Terminal | null = null;
  private activityMap: Float64Array | null = null;
  private removeOnRender: (() => void) | null = null;
  // Previous screen content: screenSnapshot[row][col] = char
  private screenSnapshot: string[][] = [];
  private lastCols: number = 0;
  private lastRows: number = 0;

  // Scroll / virtual width state
  private viewWidth: number = 0;
  private virtualWidth: number = 0;
  private scrollX: number = 0;

  // Animation
  private animFrameId: number | null = null;
  private lastFrameTime: number = 0;

  // Overlay timer
  private overlayTimer: ReturnType<typeof setTimeout> | null = null;

  // Drag state — canvas viewport drag
  private canvasDragActive: boolean = false;
  private canvasDragStartX: number = 0;
  private canvasDragStartScrollX: number = 0;

  // Hover state
  private isHovered: boolean = false;

  // Callbacks
  public onScrollChange: (() => void) | null = null;
  public onVirtualWidthConfirmed: (() => void) | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    overlay: HTMLElement,
    scrollThumb: HTMLElement,
    options?: MinimapOptions,
  ) {
    this.canvas = canvas;
    this.overlay = overlay;
    this.scrollThumb = scrollThumb;
    this.ctx = canvas.getContext('2d')!;
    this.decayMs = options?.decayMs ?? 5000;
    this.frameMs = 1000 / (options?.targetFps ?? 20);

    this.initCanvasEvents();
  }

  // ---- Public API ----

  /**
   * Connect to a terminal session.
   * Pass the saved activityMap (null on first connect → creates new one).
   * Returns the activityMap so the caller can persist it in TabSession.
   */
  connect(
    term: Terminal,
    activityMap: Float64Array | null,
    virtualWidth: number,
    scrollX: number,
  ): Float64Array {
    this.disconnect();

    this.term = term;
    this.viewWidth = this.canvas.offsetWidth || 1;
    this.virtualWidth = Math.max(virtualWidth > 0 ? virtualWidth : this.viewWidth, this.viewWidth);
    this.scrollX = Math.max(0, Math.min(scrollX, this.virtualWidth - this.viewWidth));

    // Create or reuse activityMap (reset if col count changed)
    this.activityMap = (activityMap && activityMap.length === term.cols)
      ? activityMap
      : new Float64Array(term.cols).fill(0);

    // Track renders — compare each cell with previous snapshot per column
    // A column lights up if ANY row in that column changed content.
    this.screenSnapshot = [];
    this.lastCols = term.cols;
    this.lastRows = term.rows;
    const disposable = term.onRender(({ start, end }) => {
      const now = performance.now();
      const buf = term.buffer.active;
      const cols = term.cols;
      const rows = term.rows;

      // Reset to dark on any resize (cols or rows change)
      if (cols !== this.lastCols || rows !== this.lastRows) {
        this.resetActivity();
      }

      for (let row = start; row <= end; row++) {
        const line = buf.getLine(row);
        if (!line) continue;
        const isNewRow = !this.screenSnapshot[row] || this.screenSnapshot[row].length !== cols;
        if (isNewRow) {
          // First time seeing this row: just record current content, no activity
          this.screenSnapshot[row] = new Array(cols);
          for (let col = 0; col < cols; col++) {
            const cell = line.getCell(col);
            this.screenSnapshot[row][col] = cell ? (cell.getChars() || ' ') : ' ';
          }
        } else {
          const snapRow = this.screenSnapshot[row];
          for (let col = 0; col < cols; col++) {
            const cell = line.getCell(col);
            const ch = cell ? (cell.getChars() || ' ') : ' ';
            if (ch !== snapRow[col]) {
              this.activityMap![col] = now;
              snapRow[col] = ch;
            }
          }
        }
      }
    });
    this.removeOnRender = () => disposable.dispose();

    this.syncCanvasSize();
    this.startLoop();

    return this.activityMap;
  }

  /** Disconnect from current terminal. */
  disconnect(): void {
    this.stopLoop();
    this.removeOnRender?.();
    this.removeOnRender = null;
    this.term = null;
    this.activityMap = null;
    this.screenSnapshot = [];
  }

  /** Call when the terminal stack (view) width changes. */
  setViewWidth(px: number): void {
    if (px <= 0) return;
    // Keep extra expansion in pixels (not ratio) so absolute offset stays
    const extraPx = Math.max(0, this.virtualWidth - this.viewWidth);
    this.viewWidth = px;
    this.virtualWidth = px + extraPx;
    this.scrollX = Math.max(0, Math.min(this.scrollX, this.virtualWidth - this.viewWidth));
    this.syncCanvasSize();
  }

  /** Reset heatmap activity and snapshots (dark start). */
  private resetActivity(): void {
    if (this.term) {
      this.activityMap = new Float64Array(this.term.cols).fill(0);
      this.lastCols = this.term.cols;
      this.lastRows = this.term.rows;
    }
    this.screenSnapshot = [];
  }

  /** Expand/shrink virtual width by ±colsDelta columns. */
  adjustVirtualWidth(colsDelta: number): void {
    if (!this.term || this.viewWidth <= 0) return;
    const charPx = this.viewWidth / this.term.cols;
    const deltaPx = colsDelta * charPx;
    this.virtualWidth = Math.max(
      this.viewWidth,
      Math.min(this.viewWidth * 8, this.virtualWidth + deltaPx),
    );
    this.scrollX = Math.min(this.scrollX, Math.max(0, this.virtualWidth - this.viewWidth));
    this.resetActivity();
    this.showOverlay();
    this.onVirtualWidthConfirmed?.();
    this.onScrollChange?.();
  }

  /** Reset virtual width to view width. */
  resetVirtualWidth(): void {
    this.virtualWidth = this.viewWidth;
    this.scrollX = 0;
    this.resetActivity();
    this.showOverlay();
    this.onVirtualWidthConfirmed?.();
    this.onScrollChange?.();
  }

  /** Scroll viewport by deltaPx pixels. */
  scrollBy(deltaPx: number): void {
    const maxScroll = this.virtualWidth - this.viewWidth;
    if (maxScroll <= 0) return;
    const prev = this.scrollX;
    this.scrollX = Math.max(0, Math.min(maxScroll, this.scrollX + deltaPx));
    if (this.scrollX !== prev) {
      this.onScrollChange?.();
    }
  }

  /** Scroll to the very start (left edge). */
  scrollToStart(): void {
    if (this.scrollX !== 0) {
      this.scrollX = 0;
      this.onScrollChange?.();
    }
  }

  /** Scroll to the very end (right edge). */
  scrollToEnd(): void {
    const maxScroll = this.virtualWidth - this.viewWidth;
    if (maxScroll <= 0) return;
    if (this.scrollX !== maxScroll) {
      this.scrollX = maxScroll;
      this.onScrollChange?.();
    }
  }

  getVirtualWidth(): number { return this.virtualWidth; }
  getScrollX(): number { return this.scrollX; }

  // ---- Private: event handlers ----

  private initCanvasEvents(): void {
    // Click → jump scroll to position
    this.canvas.addEventListener('click', (e) => {
      if (this.canvasDragActive) return; // was a drag, not a click
      const rect = this.canvas.getBoundingClientRect();
      const ratio = (e.clientX - rect.left) / rect.width;
      const target = ratio * this.virtualWidth - this.viewWidth / 2;
      this.scrollX = Math.max(0, Math.min(this.virtualWidth - this.viewWidth, target));
      this.onScrollChange?.();
    });

    // Drag viewport
    this.canvas.addEventListener('mousedown', (e) => {
      this.canvasDragActive = false;
      this.canvasDragStartX = e.clientX;
      this.canvasDragStartScrollX = this.scrollX;

      const onMove = (e: MouseEvent) => {
        const dx = e.clientX - this.canvasDragStartX;
        if (Math.abs(dx) > 3) this.canvasDragActive = true;
        if (!this.canvasDragActive) return;
        const ratio = this.virtualWidth / (this.canvas.offsetWidth || 1);
        this.scrollX = Math.max(
          0,
          Math.min(this.virtualWidth - this.viewWidth, this.canvasDragStartScrollX + dx * ratio),
        );
        this.onScrollChange?.();
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    // Hover state tracking
    this.canvas.addEventListener('mouseenter', () => { this.isHovered = true; });
    this.canvas.addEventListener('mouseleave', () => { this.isHovered = false; });

    // Wheel: Ctrl+wheel のみ仮想幅変更、通常スクロールは無効 (クリック/ドラッグで代替)
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.ctrlKey) {
        const delta = e.deltaX !== 0 ? e.deltaX : e.deltaY;
        const colsDelta = delta < 0 ? 3 : -3;
        this.adjustVirtualWidth(colsDelta);
      }
    }, { passive: false });
  }

  // ---- Private: rendering ----

  private syncCanvasSize(): void {
    const w = this.canvas.offsetWidth;
    const h = this.canvas.offsetHeight;
    if (w > 0 && h > 0) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  private startLoop(): void {
    this.stopLoop();
    const frame = (ts: number) => {
      this.animFrameId = requestAnimationFrame(frame);
      if (ts - this.lastFrameTime < this.frameMs) return;
      this.lastFrameTime = ts;
      this.render(ts);
    };
    this.animFrameId = requestAnimationFrame(frame);
  }

  private stopLoop(): void {
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  private render(now: number): void {
    if (!this.term || !this.activityMap) return;

    const W = this.canvas.width;
    const H = this.canvas.height;
    if (W <= 0 || H <= 0) return;

    const imageData = this.ctx.createImageData(W, H);
    const data = imageData.data;

    const actMap = this.activityMap;
    const cols = actMap.length; // Use activityMap length (matches current term.cols)

    // Precompute color per canvas pixel column
    const colColors = new Uint8Array(W * 3);
    for (let px = 0; px < W; px++) {
      const colF = (px / W) * cols;
      const colStart = Math.floor(colF);
      const colEnd = Math.min(cols, Math.floor(((px + 1) / W) * cols) + 1);

      let total = 0;
      let count = 0;
      for (let c = colStart; c < colEnd; c++) {
        total += computeScore(actMap[c], now, this.decayMs);
        count++;
      }
      const score = count > 0 ? total / count : 0;
      const [r, g, b] = scoreToColor(score);

      // Glow for near-zero score (completed)
      const glowAlpha = score < 0.1 ? ((0.1 - score) / 0.1) * 0.25 : 0;
      colColors[px * 3 + 0] = Math.min(255, Math.round(r + (168 - r) * glowAlpha));
      colColors[px * 3 + 1] = Math.min(255, Math.round(g + (230 - g) * glowAlpha));
      colColors[px * 3 + 2] = Math.min(255, Math.round(b + (255 - b) * glowAlpha));
    }

    // Fill imageData — same color for entire column
    for (let py = 0; py < H; py++) {
      for (let px = 0; px < W; px++) {
        const idx = (py * W + px) * 4;
        data[idx + 0] = colColors[px * 3 + 0];
        data[idx + 1] = colColors[px * 3 + 1];
        data[idx + 2] = colColors[px * 3 + 2];
        data[idx + 3] = 255;
      }
    }

    this.ctx.putImageData(imageData, 0, 0);

    // Viewport indicator
    this.renderViewport(W, H);
  }

  private renderViewport(W: number, _H: number): void {
    const trackWidth = this.scrollThumb.parentElement?.offsetWidth ?? W;
    if (this.virtualWidth <= this.viewWidth) {
      // スクロール不要: サムを非表示
      this.scrollThumb.style.display = 'none';
      return;
    }
    const ratio = trackWidth / this.virtualWidth;
    const left = Math.round(this.scrollX * ratio);
    const width = Math.max(4, Math.round(this.viewWidth * ratio));
    this.scrollThumb.style.display = 'block';
    this.scrollThumb.style.left = `${left}px`;
    this.scrollThumb.style.width = `${width}px`;
  }

  // ---- Private: overlay ----

  private showOverlay(): void {
    if (!this.term) return;
    const cols = Math.round(this.term.cols * this.virtualWidth / Math.max(1, this.viewWidth));
    this.overlay.textContent = `${cols} cols`;
    this.overlay.classList.add('visible');
    if (this.overlayTimer) clearTimeout(this.overlayTimer);
    this.overlayTimer = setTimeout(() => this.overlay.classList.remove('visible'), 1200);
  }
}
