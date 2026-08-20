// ScrapLLM Motion
// A tiny spring/gesture runtime shared by the popup and the in-page notification.
//
// Why not CSS transitions: anything the user can touch must be interruptible and
// must start from its *current* on-screen value, carrying the velocity it
// already had. CSS transitions and @keyframes restart from a prescribed curve,
// so grabbing a moving element mid-flight snaps. Springs don't.
//
// Parameters follow Apple's designer-facing pair rather than mass/stiffness/
// damping: `response` (seconds to approach the target) and `damping` (1 =
// critically damped, no overshoot; < 1 bounces).
const ScrapLLMMotion = (function () {
  'use strict';

  const REST_DISPLACEMENT = 0.01;
  const REST_VELOCITY = 0.05;
  // Cap the step so a background tab (or a long paint) can't teleport a spring.
  const MAX_STEP = 1 / 30;

  // Apple's house values (Designing Fluid Interfaces).
  const PRESETS = {
    move: { damping: 1.0, response: 0.4 },   // reposition, no overshoot
    sheet: { damping: 0.8, response: 0.3 },  // drawers, sheets
    rotate: { damping: 0.8, response: 0.4 },
    snappy: { damping: 1.0, response: 0.28 } // small controls
  };

  function prefersReducedMotion() {
    return typeof matchMedia === 'function' &&
           matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  // --------------------------------------------------------------------------
  // Spring
  // --------------------------------------------------------------------------

  // Analytic solution of a damped harmonic oscillator, advanced by dt each
  // frame from the *live* (value, velocity) pair. Re-targeting mid-flight
  // therefore continues from the current state instead of cutting velocity to
  // zero, which is what makes a reversed gesture feel elastic instead of
  // hitting a brick wall.
  class Spring {
    constructor(value, options) {
      const opts = options || {};
      this.value = value;
      this.velocity = opts.velocity || 0;
      this.target = value;
      this.damping = clamp(opts.damping !== undefined ? opts.damping : 1, 0.05, 1);
      this.response = Math.max(opts.response !== undefined ? opts.response : 0.4, 0.01);
      this.onUpdate = opts.onUpdate || null;
      this.onRest = opts.onRest || null;
      this.frame = null;
      this.lastTime = 0;
    }

    // Change where we're heading without disturbing the motion already in
    // flight. `options.velocity` adds a gesture hand-off on top of it.
    to(target, options) {
      const opts = options || {};
      if (opts.damping !== undefined) this.damping = clamp(opts.damping, 0.05, 1);
      if (opts.response !== undefined) this.response = Math.max(opts.response, 0.01);
      if (opts.velocity !== undefined) this.velocity = opts.velocity;
      this.target = target;

      if (prefersReducedMotion() && !opts.force) {
        // Reduced motion: land immediately and let the caller cross-fade
        // instead of travelling the distance.
        this.stop();
        this.value = target;
        this.velocity = 0;
        this.emit();
        if (this.onRest) this.onRest(this);
        return this;
      }

      this.start();
      return this;
    }

    // Jump to a value with no animation (used while a finger is down: the
    // element must track 1:1, not spring toward the finger).
    set(value, velocity) {
      this.stop();
      this.value = value;
      this.velocity = velocity !== undefined ? velocity : 0;
      this.target = value;
      this.emit();
      return this;
    }

    start() {
      if (this.frame !== null) return;
      this.lastTime = now();
      const tick = () => {
        const time = now();
        const dt = Math.min((time - this.lastTime) / 1000, MAX_STEP);
        this.lastTime = time;
        this.advance(dt);
        this.emit();

        if (this.isAtRest()) {
          this.value = this.target;
          this.velocity = 0;
          this.emit();
          this.frame = null;
          if (this.onRest) this.onRest(this);
          return;
        }
        this.frame = requestAnimationFrame(tick);
      };
      this.frame = requestAnimationFrame(tick);
    }

    stop() {
      if (this.frame !== null) {
        cancelAnimationFrame(this.frame);
        this.frame = null;
      }
      return this;
    }

    get isAnimating() {
      return this.frame !== null;
    }

    advance(dt) {
      if (dt <= 0) return;
      const omega = (2 * Math.PI) / this.response;
      const zeta = this.damping;
      const x0 = this.value - this.target;
      const v0 = this.velocity;
      const decay = Math.exp(-zeta * omega * dt);

      if (zeta < 1) {
        const omegaD = omega * Math.sqrt(1 - zeta * zeta);
        const c1 = x0;
        const c2 = (v0 + zeta * omega * x0) / omegaD;
        const cos = Math.cos(omegaD * dt);
        const sin = Math.sin(omegaD * dt);
        this.value = this.target + decay * (c1 * cos + c2 * sin);
        this.velocity = decay * (
          (-zeta * omega) * (c1 * cos + c2 * sin) +
          omegaD * (c2 * cos - c1 * sin)
        );
      } else {
        // Critically damped
        const c2 = v0 + omega * x0;
        this.value = this.target + decay * (x0 + c2 * dt);
        this.velocity = decay * (c2 - omega * (x0 + c2 * dt));
      }
    }

    isAtRest() {
      return Math.abs(this.value - this.target) < REST_DISPLACEMENT &&
             Math.abs(this.velocity) < REST_VELOCITY;
    }

    emit() {
      if (this.onUpdate) this.onUpdate(this.value, this);
    }
  }

  // --------------------------------------------------------------------------
  // Physics helpers
  // --------------------------------------------------------------------------

  // Where a flick would come to rest, using the same exponential decay as
  // scroll deceleration. Snap decisions are made against this projection, not
  // against the release point, so a small fast flick still throws the element.
  function project(velocity, decelerationRate) {
    const rate = decelerationRate === undefined ? 0.998 : decelerationRate;
    return (velocity / 1000) * rate / (1 - rate);
  }

  // Progressive resistance past a boundary: the further out, the less the
  // element follows. A hard stop reads as frozen; this reads as "nothing more
  // here, but I'm still listening".
  function rubberband(overshoot, dimension, constant) {
    const c = constant === undefined ? 0.55 : constant;
    if (!dimension) return 0;
    return (overshoot * dimension * c) / (dimension + c * Math.abs(overshoot));
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function now() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  // --------------------------------------------------------------------------
  // Gestures
  // --------------------------------------------------------------------------

  // Pointer tracking with capture, grab-offset preservation and a short
  // position history so the release velocity reflects the last few
  // milliseconds of the gesture rather than the whole drag.
  //
  // options: { axis: 'x' | 'y', threshold, onStart, onMove, onEnd, canStart }
  function draggable(element, options) {
    const opts = options || {};
    const axis = opts.axis === 'y' ? 'y' : 'x';
    const threshold = opts.threshold !== undefined ? opts.threshold : 10;
    const history = [];
    let pointerId = null;
    let origin = null;
    let engaged = false;

    const point = (event) => (axis === 'y' ? event.clientY : event.clientX);
    const cross = (event) => (axis === 'y' ? event.clientX : event.clientY);

    function onPointerDown(event) {
      if (pointerId !== null || event.button > 0) return;
      if (opts.canStart && !opts.canStart(event)) return;
      pointerId = event.pointerId;
      // Captured here, not once the gesture engages: a surface that is already
      // animating keeps moving under the finger, and without capture the very
      // next pointermove lands somewhere else and the element never hears it —
      // which is why a closing sheet could not be caught. Capture retargets the
      // whole sequence to this element, so the gesture is evaluated against the
      // finger rather than against wherever the surface happens to be.
      if (typeof element.setPointerCapture === 'function') {
        try {
          element.setPointerCapture(event.pointerId);
        } catch (e) {
          // A pointer that ended between the hit test and here: the gesture is
          // simply evaluated without capture, as before.
        }
      }
      origin = { main: point(event), cross: cross(event), time: now() };
      engaged = false;
      history.length = 0;
      history.push({ value: origin.main, time: origin.time });
    }

    function onPointerMove(event) {
      if (event.pointerId !== pointerId) return;
      const value = point(event);
      const delta = value - origin.main;
      const crossDelta = cross(event) - origin.cross;

      if (!engaged) {
        // Every plausible gesture is evaluated from the first move; the losers
        // are cancelled once the dominant direction is clear (>10px and ahead
        // of the perpendicular movement).
        if (Math.abs(delta) < threshold) return;
        if (Math.abs(delta) <= Math.abs(crossDelta)) {
          if (element.hasPointerCapture && element.hasPointerCapture(pointerId)) {
            element.releasePointerCapture(pointerId);
          }
          pointerId = null;
          return;
        }
        engaged = true;
        // Re-anchor so the element doesn't jump by the threshold distance.
        origin.main = value - Math.sign(delta) * threshold;
        if (opts.onStart) opts.onStart({ delta: value - origin.main, event });
      }

      history.push({ value, time: now() });
      if (history.length > 6) history.shift();
      if (opts.onMove) opts.onMove({ delta: value - origin.main, event });
    }

    function finish(event, cancelled) {
      if (event.pointerId !== pointerId) return;
      const wasEngaged = engaged;
      pointerId = null;
      engaged = false;
      if (element.hasPointerCapture && element.hasPointerCapture(event.pointerId)) {
        element.releasePointerCapture(event.pointerId);
      }
      if (!wasEngaged) return;
      if (opts.onEnd) {
        opts.onEnd({
          delta: point(event) - origin.main,
          velocity: cancelled ? 0 : velocityFromHistory(history),
          cancelled: !!cancelled,
          event
        });
      }
    }

    element.addEventListener('pointerdown', onPointerDown);
    element.addEventListener('pointermove', onPointerMove);
    element.addEventListener('pointerup', (e) => finish(e, false));
    element.addEventListener('pointercancel', (e) => finish(e, true));

    return {
      get isDragging() { return engaged; },
      destroy() {
        element.removeEventListener('pointerdown', onPointerDown);
        element.removeEventListener('pointermove', onPointerMove);
      }
    };
  }

  // px/s over the tail of the gesture. Using only the last two points makes the
  // number jittery; using the whole drag makes a flick at the end invisible.
  function velocityFromHistory(history) {
    if (history.length < 2) return 0;
    const last = history[history.length - 1];
    let first = history[0];
    for (let i = history.length - 2; i >= 0; i--) {
      first = history[i];
      if (last.time - first.time > 60) break;
    }
    const dt = (last.time - first.time) / 1000;
    if (dt <= 0) return 0;
    return (last.value - first.value) / dt;
  }

  // --------------------------------------------------------------------------
  // Press feedback
  // --------------------------------------------------------------------------

  // Feedback belongs on pointer-down, not on click: waiting for the release to
  // acknowledge a press is the single most common way an interface reads as
  // dead. Dragging off the control cancels it; dragging back re-arms it.
  function pressable(root, selector, className) {
    const cls = className || 'is-pressed';
    let pressed = null;
    let activePointer = null;

    function press(target) {
      if (pressed === target) return;
      release();
      pressed = target;
      pressed.classList.add(cls);
    }

    function release() {
      if (pressed) pressed.classList.remove(cls);
      pressed = null;
    }

    root.addEventListener('pointerdown', (event) => {
      if (event.button > 0) return;
      const target = event.target.closest(selector);
      if (!target || target.disabled) return;
      activePointer = event.pointerId;
      press(target);
    });

    root.addEventListener('pointermove', (event) => {
      if (event.pointerId !== activePointer || !pressed) return;
      const rect = pressed.getBoundingClientRect();
      // ~10px of slop so a shaky finger doesn't drop the highlight.
      const inside = event.clientX >= rect.left - 10 && event.clientX <= rect.right + 10 &&
                     event.clientY >= rect.top - 10 && event.clientY <= rect.bottom + 10;
      pressed.classList.toggle(cls, inside);
    });

    const end = () => { activePointer = null; release(); };
    root.addEventListener('pointerup', end);
    root.addEventListener('pointercancel', end);
    window.addEventListener('blur', end);
  }

  return {
    Spring,
    PRESETS,
    project,
    rubberband,
    clamp,
    draggable,
    pressable,
    prefersReducedMotion
  };
})();

if (typeof window !== 'undefined') {
  window.ScrapLLMMotion = ScrapLLMMotion;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ScrapLLMMotion;
}
