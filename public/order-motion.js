export function createOrderMotion(panel, formatMoney) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const style = getComputedStyle(panel);
  const duration = Number.parseFloat(style.getPropertyValue('--dur-base'));
  const easing = style.getPropertyValue('--ease-out').trim();
  const counters = new WeakMap();

  function animate(element, keyframes) {
    if (reduced.matches) return;
    return element.animate?.(keyframes, { duration, easing });
  }

  return {
    enter(row) {
      animate(row, [{ transform: 'translateY(8px)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }]);
    },
    remove(row) {
      const animation = animate(row, [{ opacity: 1 }, { transform: 'translateY(-4px)', opacity: 0 }]);
      if (animation) animation.finished.then(() => row.remove(), () => row.remove());
      else row.remove();
    },
    quantity(slot, previous, next) {
      const value = document.createElement('span');
      value.textContent = next;
      slot.replaceChildren(value);
      if (previous === undefined || reduced.matches) return;
      const old = document.createElement('del');
      old.textContent = previous;
      old.setAttribute('aria-hidden', 'true');
      slot.prepend(old);
      const exit = animate(old, [
        { opacity: 1, transform: 'translateY(0)' },
        { opacity: 0, transform: 'translateY(-85%)' },
      ]);
      animate(value, [{ opacity: 0, transform: 'translateY(85%)' }, { opacity: 1, transform: 'translateY(0)' }]);
      if (exit) exit.finished.then(() => old.remove(), () => old.remove());
      else old.remove();
    },
    money(element, cents) {
      const previous = counters.get(element);
      if (previous?.target === cents) return;
      if (previous) cancelAnimationFrame(previous.frame);
      const state = { value: previous?.value ?? cents, target: cents };
      counters.set(element, state);
      if (reduced.matches || !previous) {
        state.value = cents;
        element.textContent = formatMoney(cents);
        return;
      }
      const start = state.value;
      const began = performance.now();
      function tick(now) {
        if (!element.isConnected) return;
        const progress = Math.min(1, (now - began) / duration);
        state.value = Math.round(start + (cents - start) * (1 - (1 - progress) ** 3));
        element.textContent = formatMoney(state.value);
        if (progress < 1) state.frame = requestAnimationFrame(tick);
      }
      state.frame = requestAnimationFrame(tick);
    },
  };
}
