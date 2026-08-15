/**
 * RelayOne — message effects.
 *
 * Small, tasteful particle bursts played when certain reactions land. Pure
 * client-side: a transient full-screen <canvas> overlay that animates for ~1.3s
 * and removes itself. No dependencies, no layout impact (pointer-events: none).
 */

const EMOJI = { hearts: "❤️", fire: "🔥", stars: "⭐" };
const CONFETTI_COLORS = ["#168BFF", "#713BFF", "#35D6A4", "#FFC64B", "#FF5C7A", "#54E0FF"];

/** Map a reaction emoji to an effect name, or null if it has none. */
export function effectForEmoji(emoji) {
  if (emoji === "🎉") return "confetti";
  if (emoji === "❤️") return "hearts";
  if (emoji === "🔥") return "fire";
  if (emoji === "⭐") return "stars";
  return null;
}

const reduceMotion =
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function playEffect(type) {
  if (reduceMotion || typeof document === "undefined") return;

  const canvas = document.createElement("canvas");
  canvas.className = "fx-canvas";
  const ctx = canvas.getContext("2d");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = window.innerWidth;
  const H = window.innerHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.cssText =
    "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:400;";
  ctx.scale(dpr, dpr);
  document.body.appendChild(canvas);

  const particles = spawn(type, W, H);
  const start = performance.now();
  const DURATION = 1300;

  function frame(now) {
    const t = now - start;
    ctx.clearRect(0, 0, W, H);
    for (const p of particles) {
      p.vy += p.gravity;
      p.x += p.vx;
      p.y += p.vy;
      p.rot += p.vr;
      const life = 1 - t / DURATION;
      ctx.globalAlpha = Math.max(0, life);
      if (p.emoji) {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.font = `${p.size}px serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(p.emoji, 0, 0);
        ctx.restore();
      } else {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        ctx.restore();
      }
    }
    if (t < DURATION) {
      requestAnimationFrame(frame);
    } else {
      canvas.remove();
    }
  }
  requestAnimationFrame(frame);
}

function spawn(type, W, H) {
  const particles = [];
  const emoji = EMOJI[type];
  const count = emoji ? 18 : 90;
  const originX = W / 2;
  const originY = H * 0.72;

  for (let i = 0; i < count; i += 1) {
    if (emoji) {
      // Rise from the lower area and drift.
      particles.push({
        x: originX + (Math.random() - 0.5) * W * 0.5,
        y: H + 20 + Math.random() * 40,
        vx: (Math.random() - 0.5) * 1.5,
        vy: -(4 + Math.random() * 4),
        gravity: 0.03,
        rot: (Math.random() - 0.5) * 0.6,
        vr: (Math.random() - 0.5) * 0.06,
        size: 22 + Math.random() * 18,
        emoji,
      });
    } else {
      // Confetti burst upward + out, then falls.
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.9;
      const speed = 6 + Math.random() * 9;
      particles.push({
        x: originX + (Math.random() - 0.5) * 60,
        y: originY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        gravity: 0.28,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.4,
        size: 7 + Math.random() * 6,
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      });
    }
  }
  return particles;
}
