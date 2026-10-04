import { hash, hueOf, WORLD, ZONES, type Pose, type TimedLine } from "./world";

/** Draws the Room's floor and furniture once into an offscreen canvas (redrawn only on resize). */
export function renderBackground(scale: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.ceil(WORLD.w * scale);
  c.height = Math.ceil(WORLD.h * scale);
  const g = c.getContext("2d")!;
  g.scale(scale, scale);

  // Floor with soft tiles.
  g.fillStyle = "#ebe6f7";
  g.fillRect(0, 0, WORLD.w, WORLD.h);
  g.strokeStyle = "rgba(120, 100, 180, 0.08)";
  g.lineWidth = 1;
  for (let x = 0; x <= WORLD.w; x += 60) line(g, x, 0, x, WORLD.h);
  for (let y = 0; y <= WORLD.h; y += 60) line(g, 0, y, WORLD.w, y);

  // Walkways connecting the areas.
  g.strokeStyle = "rgba(255,255,255,0.75)";
  g.lineWidth = 70;
  g.lineCap = "round";
  const centers = ZONES.map((z) => ({ x: z.x + z.w / 2, y: z.y + z.h / 2 }));
  const hub = { x: 1200, y: 850 };
  for (const p of centers) line(g, hub.x, hub.y, p.x, p.y);

  for (const z of ZONES) {
    roundRect(g, z.x, z.y, z.w, z.h, 36);
    g.fillStyle = z.color;
    g.fill();
    g.strokeStyle = "rgba(60, 40, 120, 0.12)";
    g.lineWidth = 3;
    g.stroke();
    decorate(g, z.key, z);
    g.fillStyle = "rgba(40, 28, 80, 0.55)";
    g.font = "700 26px 'Bricolage Grotesque', system-ui, sans-serif";
    g.fillText(z.label, z.x + 26, z.y + 42);
  }

  // Scattered plants on the open floor.
  const r = seeded(7);
  for (let i = 0; i < 26; i++) {
    const x = 40 + r() * (WORLD.w - 80);
    const y = 40 + r() * (WORLD.h - 80);
    if (ZONES.some((z) => x > z.x - 20 && x < z.x + z.w + 20 && y > z.y - 20 && y < z.y + z.h + 20)) continue;
    plant(g, x, y, 14 + r() * 10);
  }
  return c;
}

function decorate(g: CanvasRenderingContext2D, key: string, z: { x: number; y: number; w: number; h: number }) {
  const r = seeded(hash(key));
  if (key === "cafe") {
    for (let i = 0; i < 6; i++) {
      const x = z.x + 90 + (i % 3) * 190;
      const y = z.y + 150 + Math.floor(i / 3) * 170;
      circle(g, x, y, 34, "#fffaf2", "rgba(120,80,40,0.25)");
      circle(g, x - 46, y, 12, "#c9a27e");
      circle(g, x + 46, y, 12, "#c9a27e");
      circle(g, x, y, 6, "#8b5e3c");
    }
    roundRect(g, z.x + z.w - 150, z.y + 30, 120, 40, 10);
    g.fillStyle = "#8b5e3c";
    g.fill();
  } else if (key === "desk") {
    for (let i = 0; i < 6; i++) {
      const x = z.x + 60 + (i % 3) * 200;
      const y = z.y + 110 + Math.floor(i / 3) * 140;
      roundRect(g, x, y, 150, 60, 8);
      g.fillStyle = "#ffffff";
      g.fill();
      for (let m = 0; m < 3; m++) {
        roundRect(g, x + 10 + m * 46, y + 8, 40, 26, 4);
        g.fillStyle = "#1c2233";
        g.fill();
        // Tiny chart squiggle on each monitor.
        g.strokeStyle = r() > 0.5 ? "#26a69a" : "#ef5350";
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(x + 14 + m * 46, y + 28);
        for (let s = 1; s < 6; s++) g.lineTo(x + 14 + m * 46 + s * 6, y + 14 + r() * 16);
        g.stroke();
      }
    }
  } else if (key === "stage") {
    roundRect(g, z.x + 70, z.y + 80, z.w - 140, 150, 20);
    g.fillStyle = "#b99ae6";
    g.fill();
    for (let i = 0; i < 5; i++) circle(g, z.x + 120 + i * ((z.w - 240) / 4), z.y + 95, 9, "#fff6c2");
    for (let row = 0; row < 2; row++)
      for (let i = 0; i < 6; i++) circle(g, z.x + 100 + i * 75, z.y + 300 + row * 60, 14, "#d9c6f2", "rgba(80,50,140,0.25)");
  } else if (key === "garden") {
    for (let i = 0; i < 14; i++) plant(g, z.x + 50 + r() * (z.w - 100), z.y + 80 + r() * (z.h - 120), 16 + r() * 18);
    roundRect(g, z.x + z.w / 2 - 90, z.y + z.h / 2 - 18, 180, 36, 10);
    g.fillStyle = "#b08868";
    g.fill();
  } else if (key === "fountain") {
    const cx = z.x + z.w / 2;
    const cy = z.y + z.h / 2 + 10;
    circle(g, cx, cy, 120, "#bcd9e8", "rgba(40,90,130,0.35)");
    circle(g, cx, cy, 92, "#9fcbe0");
    circle(g, cx, cy, 30, "#e6f3f9", "rgba(40,90,130,0.35)");
    g.strokeStyle = "rgba(255,255,255,0.7)";
    g.lineWidth = 2;
    for (let i = 1; i <= 2; i++) {
      g.beginPath();
      g.arc(cx, cy, 30 + i * 22, 0, Math.PI * 2);
      g.stroke();
    }
  } else if (key === "lounge") {
    for (let i = 0; i < 3; i++) {
      const x = z.x + 80 + i * 190;
      roundRect(g, x, z.y + 120, 150, 54, 22);
      g.fillStyle = ["#c98fa1", "#a68fc9", "#8fb6c9"][i]!;
      g.fill();
      roundRect(g, x + 25, z.y + 200, 100, 50, 10);
      g.fillStyle = "#fff";
      g.fill();
    }
    roundRect(g, z.x + 120, z.y + 330, z.w - 240, 180, 60);
    g.fillStyle = "rgba(255,255,255,0.45)";
    g.fill();
  }
}

function plant(g: CanvasRenderingContext2D, x: number, y: number, r: number) {
  circle(g, x, y + r * 0.6, r * 0.55, "#c99a76");
  circle(g, x - r * 0.4, y, r * 0.6, "#6fb67a");
  circle(g, x + r * 0.4, y, r * 0.6, "#5ea86b");
  circle(g, x, y - r * 0.35, r * 0.65, "#7cc489");
}

function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function line(g: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) {
  g.beginPath();
  g.moveTo(x1, y1);
  g.lineTo(x2, y2);
  g.stroke();
}
function circle(g: CanvasRenderingContext2D, x: number, y: number, r: number, fill: string, stroke?: string) {
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fillStyle = fill;
  g.fill();
  if (stroke) {
    g.strokeStyle = stroke;
    g.lineWidth = 2;
    g.stroke();
  }
}
export function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}

export const AVATAR_R = 26;

/** One character: shadow, walking bob, round portrait with a coloured ring, and a name tag. */
export function drawCharacter(
  g: CanvasRenderingContext2D,
  id: string,
  pose: Pose,
  img: HTMLImageElement | undefined,
  label: string,
  t: number,
  opts: { selected: boolean; followed: boolean; dim: boolean; showLabel: boolean },
) {
  const bob = pose.moving ? Math.abs(Math.sin(t * 9 + (hash(id) % 10))) * 5 : pose.talking ? Math.sin(t * 3) * 1 : 0;
  const x = pose.x;
  const y = pose.y - bob;
  const hue = hueOf(id);
  g.save();
  if (opts.dim) g.globalAlpha = 0.35;

  // Shadow
  g.beginPath();
  g.ellipse(pose.x, pose.y + AVATAR_R + 4, AVATAR_R * 0.85, 7, 0, 0, Math.PI * 2);
  g.fillStyle = "rgba(40, 28, 80, 0.18)";
  g.fill();

  // Selection glow
  if (opts.selected || opts.followed) {
    g.beginPath();
    g.arc(x, y, AVATAR_R + 10 + Math.sin(t * 4) * 2, 0, Math.PI * 2);
    g.fillStyle = "rgba(91, 61, 245, 0.18)";
    g.fill();
  }

  // Portrait
  g.save();
  g.beginPath();
  g.arc(x, y, AVATAR_R, 0, Math.PI * 2);
  g.closePath();
  g.fillStyle = `hsl(${hue} 60% 85%)`;
  g.fill();
  g.clip();
  if (img && img.complete && img.naturalWidth > 0) {
    // Not mirrored: token images often contain text or logos.
    g.drawImage(img, x - AVATAR_R, y - AVATAR_R, AVATAR_R * 2, AVATAR_R * 2);
  }
  g.restore();
  g.beginPath();
  g.arc(x, y, AVATAR_R, 0, Math.PI * 2);
  g.strokeStyle = opts.selected || opts.followed ? "#5b3df5" : `hsl(${hue} 65% 52%)`;
  g.lineWidth = opts.selected || opts.followed ? 4 : 3;
  g.stroke();

  // Talking indicator: little sound arcs
  if (pose.talking) {
    g.strokeStyle = `hsl(${hue} 65% 45%)`;
    g.lineWidth = 2;
    for (let i = 1; i <= 2; i++) {
      g.beginPath();
      const dir = pose.facing;
      g.arc(x, y, AVATAR_R + 4 + i * 5, dir > 0 ? -0.5 : Math.PI - 0.5, dir > 0 ? 0.5 : Math.PI + 0.5);
      g.globalAlpha = (opts.dim ? 0.35 : 1) * (0.5 + 0.5 * Math.sin(t * 6 - i));
      g.stroke();
    }
    g.globalAlpha = opts.dim ? 0.35 : 1;
  }

  // Name tag
  if (opts.showLabel) {
    g.font = "600 12px 'Schibsted Grotesk', system-ui, sans-serif";
    const w = g.measureText(label).width + 14;
    roundRect(g, pose.x - w / 2, pose.y + AVATAR_R + 10, w, 20, 10);
    g.fillStyle = opts.selected || opts.followed ? "#5b3df5" : "rgba(255,255,255,0.92)";
    g.fill();
    g.fillStyle = opts.selected || opts.followed ? "#fff" : "#1c1a24";
    g.textAlign = "center";
    g.fillText(label, pose.x, pose.y + AVATAR_R + 24);
    g.textAlign = "start";
  }
  g.restore();
}

function wrap(g: CanvasRenderingContext2D, text: string, max: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (g.measureText(next).width > max && cur) {
      lines.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** A speech bubble in screen space above the speaker, with a typewriter reveal. */
export function drawBubble(g: CanvasRenderingContext2D, sx: number, sy: number, line: TimedLine, progress: number, hue: number) {
  const shown = line.text.slice(0, Math.ceil(line.text.length * Math.min(1, progress / 0.45)));
  g.save();
  g.font = "500 14px 'Schibsted Grotesk', system-ui, sans-serif";
  const maxW = 230;
  const lines = wrap(g, line.text, maxW); // layout from the full text so the bubble doesn't jump
  const shownLines = wrap(g, shown, maxW);
  const action = line.action ? `(${line.action})` : "";
  const lh = 19;
  const textW = Math.max(...lines.map((l) => g.measureText(l).width), action ? g.measureText(action).width : 0);
  const w = Math.min(maxW, textW) + 24;
  const h = lines.length * lh + (action ? lh : 0) + 16;
  const x = Math.round(sx - w / 2);
  const y = Math.round(sy - h - 14);
  g.shadowColor = "rgba(40,28,80,0.18)";
  g.shadowBlur = 12;
  g.shadowOffsetY = 3;
  roundRect(g, x, y, w, h, 12);
  g.fillStyle = "#fff";
  g.fill();
  g.shadowColor = "transparent";
  g.strokeStyle = `hsl(${hue} 65% 55%)`;
  g.lineWidth = 2;
  g.stroke();
  // Tail
  g.beginPath();
  g.moveTo(sx - 8, y + h - 1);
  g.lineTo(sx, y + h + 10);
  g.lineTo(sx + 8, y + h - 1);
  g.closePath();
  g.fillStyle = "#fff";
  g.fill();
  g.beginPath();
  g.moveTo(sx - 8, y + h);
  g.lineTo(sx, y + h + 10);
  g.lineTo(sx + 8, y + h);
  g.stroke();
  let ty = y + 8 + 14;
  if (action) {
    g.fillStyle = "#7a7390";
    g.font = "italic 13px 'Schibsted Grotesk', system-ui, sans-serif";
    g.fillText(action, x + 12, ty);
    ty += lh;
    g.font = "500 14px 'Schibsted Grotesk', system-ui, sans-serif";
  }
  g.fillStyle = "#1c1a24";
  shownLines.forEach((l, i) => g.fillText(l, x + 12, ty + i * lh));
  g.restore();
}

/** Small topic chip floating over a conversation. */
export function drawTopic(g: CanvasRenderingContext2D, sx: number, sy: number, text: string) {
  g.save();
  g.font = "600 11px 'Schibsted Grotesk', system-ui, sans-serif";
  const label = text.length > 40 ? `${text.slice(0, 39)}…` : text;
  const w = g.measureText(label).width + 16;
  roundRect(g, sx - w / 2, sy, w, 20, 10);
  g.fillStyle = "rgba(28, 26, 36, 0.78)";
  g.fill();
  g.fillStyle = "#fff";
  g.textAlign = "center";
  g.fillText(label, sx, sy + 14);
  g.restore();
}
