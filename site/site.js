// Agent Office landing page: repo URL, the panel above the dock, copy, and the robot
// that watches your cursor and shows its states when you click it.
(() => {
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ───────── repo URL (set once in <meta name="repo">) ─────────
  const repo = document.querySelector('meta[name="repo"]')?.content?.trim() || '';
  if (repo) {
    document.querySelectorAll('[data-repo-url]').forEach((el) => { el.textContent = repo; });
    document.querySelectorAll('[data-repo-link]').forEach((el) => { el.href = repo.replace(/\.git$/, ''); });
  }

  // ───────── coffee link (set once in <meta name="donate">) ─────────
  // Until a real https checkout link is set, the checkout button shows as disabled
  // ("coming soon") so the placeholder link never goes live.
  const donate = document.querySelector('meta[name="donate"]')?.content?.trim() || '';
  const donateReady = /^https:\/\//i.test(donate) && !donate.includes('YOUR-COFFEE-LINK');
  document.querySelectorAll('[data-donate-link]').forEach((el) => {
    if (donateReady) { el.href = donate; return; }
    el.removeAttribute('href');
    el.setAttribute('aria-disabled', 'true');
    const note = el.parentElement.querySelector('.fine-note');
    if (note) note.textContent = 'The checkout link is coming soon.';
  });

  // ───────── robot ─────────
  const stage = document.querySelector('.stage');
  const svg = document.getElementById('robot');
  const robot = svg && makeRobot(svg);

  // ───────── states (the same ones the real office shows) ─────────
  const STATES = {
    watch: { label: 'watching you' },
    working: { label: 'working', kicker: 'Working', texts: ['Edit server.js', 'Read README.md', 'Bash npm test', 'Grep "TODO"', 'Write office.js'] },
    needs: { label: 'asking for your approval', kicker: 'Needs you', texts: ['Allow Bash: npm test?'] },
    turn: { label: 'done, it is your turn', kicker: 'Your turn', texts: ['Done. What’s next?'] },
    idle: { label: 'idle', kicker: 'Idle', texts: ['No activity for 30 min'] },
  };
  const ORDER = ['watch', 'working', 'needs', 'turn', 'idle'];
  const bubble = stage.querySelector('.bubble');
  const bKicker = bubble.querySelector('.b-kicker');
  const bText = bubble.querySelector('.b-text');
  const live = document.querySelector('[data-state-live]');
  const stateButtons = document.querySelectorAll('[data-set-state]');
  let state = 'watch';
  let textTimer = 0;

  function setState(next) {
    state = next;
    stage.dataset.state = next;
    robot?.setState(next);
    const s = STATES[next];
    clearInterval(textTimer);
    if (s.kicker) {
      let i = 0;
      bKicker.textContent = s.kicker;
      bText.textContent = s.texts[0];
      bubble.classList.add('show');
      if (s.texts.length > 1 && !reduceMotion) {
        textTimer = setInterval(() => { bText.textContent = s.texts[++i % s.texts.length]; }, 1700);
      }
    } else {
      bubble.classList.remove('show');
    }
    stage.setAttribute('aria-label', canSmile() ? `The robot is ${s.label}. Click its face to make it smile.` : `The robot is ${s.label}.`);
    live.textContent = `Robot: ${s.label}`;
    stateButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.setState === next)));
  }

  // Only smiles when it isn't busy, asking for approval or asleep.
  function canSmile() { return state === 'watch' || state === 'turn'; }

  // Clicking the robot makes it smile; the robot button in the dock cycles its state.
  stage.addEventListener('click', () => {
    hideHint();
    robot?.happy();
  });
  document.querySelector('[data-cycle]').addEventListener('click', () => {
    hideHint();
    setState(ORDER[(ORDER.indexOf(state) + 1) % ORDER.length]);
  });
  stateButtons.forEach((b) => b.addEventListener('click', () => {
    hideHint();
    setState(state === b.dataset.setState ? 'watch' : b.dataset.setState);
  }));

  // ?state=working (etc.) opens the page with the robot already in that state.
  const initial = new URLSearchParams(location.search).get('state');
  if (initial && initial !== 'watch' && Object.hasOwn(STATES, initial)) setState(initial);

  // A small "click me" hint shortly after load, until the first click.
  let hinted = false;
  const hintOn = setTimeout(() => {
    if (state !== 'watch') return;
    hinted = true;
    bubble.classList.add('show');
  }, 1600);
  const hintOff = setTimeout(hideHint, 7000);
  function hideHint() {
    clearTimeout(hintOn); clearTimeout(hintOff);
    if (hinted && state === 'watch') bubble.classList.remove('show');
    hinted = false;
  }

  // ───────── panel: one view at a time, opened from the menu in the dock ─────────
  const panel = document.getElementById('panel');
  const views = panel.querySelectorAll('[data-view]');
  const triggers = document.querySelectorAll('[data-open]');
  let current = null;
  let returnFocus = null;

  function openView(name, from) {
    if (current === name) { closePanel(); return; }
    current = name;
    if (from && !panel.contains(from)) returnFocus = from;
    views.forEach((v) => { v.hidden = v.dataset.view !== name; });
    panel.inert = false;
    panel.classList.add('open');
    panel.scrollTop = 0;
    syncTriggers();
    // the robot glances at whatever just opened
    requestAnimationFrame(() => robot?.lookAt(panel));
  }

  function closePanel() {
    if (!current) return;
    current = null;
    panel.classList.remove('open');
    panel.inert = true;
    syncTriggers();
  }

  function syncTriggers() {
    triggers.forEach((t) => {
      if (t.hasAttribute('aria-expanded')) t.setAttribute('aria-expanded', String(t.dataset.open === current));
    });
  }

  triggers.forEach((t) => t.addEventListener('click', () => openView(t.dataset.open, t)));

  document.addEventListener('click', (e) => {
    if (!current) return;
    if (panel.contains(e.target) || e.target.closest('[data-open], [data-demo], [data-cycle], .stage')) return;
    closePanel();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !current) return;
    closePanel();
    returnFocus?.focus();
  });

  // ───────── copy the clone command ─────────
  const copyBtn = document.querySelector('.copy');

  async function copyCommand() {
    const cmd = `git clone ${repo}`;
    let ok = false;
    try { await navigator.clipboard.writeText(cmd); ok = true; } catch {
      // Fallback for non-secure contexts (e.g. opened from file://)
      const ta = Object.assign(document.createElement('textarea'), { value: cmd });
      ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.append(ta); ta.select();
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
    }
    copyBtn.textContent = ok ? 'Copied' : 'Press ⌘C';
    copyBtn.classList.toggle('done', ok);
    if (ok) robot?.happy();
    clearTimeout(copyBtn._t);
    copyBtn._t = setTimeout(() => { copyBtn.textContent = 'Copy'; copyBtn.classList.remove('done'); }, 1800);
  }

  copyBtn.addEventListener('click', copyCommand);

  // ───────── demo video: modal over a blurred, slightly receding page ─────────
  const demo = document.querySelector('.demo');
  const video = demo.querySelector('video');

  document.querySelector('[data-demo]').addEventListener('click', () => {
    closePanel();
    demo.classList.remove('closing');
    demo.showModal();
    document.body.classList.add('demo-open');
    video.play().catch(() => { /* autoplay refused: the controls are there */ });
  });

  function closeDemo() {
    if (!demo.open || demo.classList.contains('closing')) return;
    video.pause();
    document.body.classList.remove('demo-open');
    if (reduceMotion) { demo.close(); return; }
    demo.classList.add('closing');
    setTimeout(() => { demo.classList.remove('closing'); demo.close(); }, 220);
  }

  demo.addEventListener('cancel', (e) => { e.preventDefault(); closeDemo(); }); // Esc
  demo.addEventListener('click', (e) => { if (e.target === demo) closeDemo(); }); // click on the blurred backdrop
  demo.querySelector('.demo-close').addEventListener('click', closeDemo);

  /**
   * Faux-3D head tracking: layers further "forward" (screen, face) move more than
   * layers behind (side of the head, ears), which move the other way. That parallax
   * reads as the head turning toward the cursor. Each state adds its own body language.
   */
  function makeRobot(svg) {
    const $ = (id) => document.getElementById(id);
    const head = $('rHead'), face = $('rFace'), back = $('rBack');
    const neck = $('rNeck'), torso = $('rTorso'), chest = $('rChest');

    // The face is drawn once; copy it into the blurred layer that lights up the mesh wires.
    const lit = svg.querySelector('[data-lit]');
    const glow = svg.querySelector('[data-glow]');
    if (lit && glow) glow.innerHTML = lit.innerHTML;
    const eyes = svg.querySelectorAll('.eyes');

    const target = { x: 0, y: 0 }, cur = { x: 0, y: 0 };
    let lastMove = -1e9, happyUntil = 0, hopUntil = 0, stateSince = 0, near = false, mode = 'watch';

    const onPoint = (cx, cy) => {
      const r = svg.getBoundingClientRect();
      if (!r.width) return;
      // the screen's centre sits ~33% down the SVG
      const hx = r.left + r.width * 0.5, hy = r.top + r.height * 0.33;
      const dx = cx - hx, dy = cy - hy;
      // normalise against the viewport so it reacts across the whole page
      target.x = clamp(dx / (innerWidth * 0.45), -1, 1);
      target.y = clamp(dy / (innerHeight * 0.5), -1, 1);
      near = Math.abs(dx) < r.width * 0.2 && Math.abs(dy) < r.height * 0.22;
      lastMove = performance.now();
    };
    addEventListener('pointermove', (e) => onPoint(e.clientX, e.clientY), { passive: true });
    addEventListener('touchmove', (e) => { const t = e.touches[0]; if (t) onPoint(t.clientX, t.clientY); }, { passive: true });
    // look at whatever gets keyboard focus
    addEventListener('focusin', (e) => {
      if (e.target.closest?.('.stage')) return;
      const b = e.target.getBoundingClientRect?.();
      if (b && b.width) onPoint(b.left + b.width / 2, b.top + b.height / 2);
    });

    // blinking (not while asleep or alarmed)
    const blink = () => {
      if (!svg.classList.contains('happy') && (mode === 'watch' || mode === 'working' || mode === 'turn')) {
        svg.classList.add('blink');
        setTimeout(() => svg.classList.remove('blink'), 130);
        // sometimes a double blink
        if (Math.random() < 0.2) setTimeout(() => { svg.classList.add('blink'); setTimeout(() => svg.classList.remove('blink'), 110); }, 260);
      }
      setTimeout(blink, 2400 + Math.random() * 3800);
    };
    if (!reduceMotion) setTimeout(blink, 1800);

    // Pause the loop while the tab is hidden.
    let running = false, prev = performance.now();
    const start = () => { if (!running && !document.hidden) { running = true; prev = performance.now(); requestAnimationFrame(tick); } };
    document.addEventListener('visibilitychange', start);

    function tick(now) {
      if (document.hidden) { running = false; return; }
      const dt = Math.min(0.05, (now - prev) / 1000); prev = now;
      const t = now / 1000;
      const still = reduceMotion ? 0 : 1;

      let shake = 0, speed = 6;
      if (mode === 'working') {
        // head down at the keyboard, small nods while typing
        target.x = Math.sin(t * 0.6) * 0.18 * still;
        target.y = 0.5 + Math.sin(t * 7) * 0.04 * still;
        near = false;
      } else if (mode === 'idle') {
        // slumped, drifting slowly
        target.x = -0.2 + Math.sin(t * 0.3) * 0.05 * still;
        target.y = 0.8;
        speed = 1.6;
        near = false;
      } else if (now - lastMove > 4000 && still) {
        // No pointer for a while (or a touch device): look around on its own.
        target.x = Math.sin(t * 0.45) * 0.55 + Math.sin(t * 1.3) * 0.08;
        target.y = -0.2 + Math.cos(t * 0.33) * 0.22;
        near = false;
      }
      // needs you: an urgent little shake every couple of seconds
      if (mode === 'needs' && still) {
        const phase = (now - stateSince) % 2200;
        if (phase < 600) shake = Math.sin(phase / 600 * Math.PI * 6) * (1 - phase / 600) * 7;
      }

      const k = 1 - Math.exp(-dt * (reduceMotion ? 20 : speed));
      cur.x += (target.x - cur.x) * k;
      cur.y += (target.y - cur.y) * k;
      const x = cur.x, y = cur.y;

      // little hop when happy or when it's your turn; breathing otherwise (slow and deep when idle)
      const hopEnd = Math.max(happyUntil, hopUntil);
      const hop = now < hopEnd ? -Math.abs(Math.sin((hopEnd - now) / 1000 * Math.PI * 3)) * 14 : 0;
      const breathe = reduceMotion ? 0 : mode === 'idle' ? Math.sin(t * 0.9) * 4 : Math.sin(t * 1.6) * 2;
      const slump = mode === 'idle' ? 10 : 0;

      set(torso, `translate(${x * 6} ${breathe * 0.5})`);
      set(chest, `translate(${x * 8} ${y * 3})`);
      set(neck, `translate(${x * 9} ${y * 4 + breathe * 0.6 + slump * 0.4})`);
      set(head, `translate(${x * 16 + shake} ${y * 12 + breathe + hop + slump}) rotate(${x * 5 + shake * 0.6 + (mode === 'idle' ? -4 : 0)} 400 330)`);
      set(back, `translate(${-x * 14} ${-y * 6})`);
      set(face, `translate(${x * 10} ${y * 7})`);
      const et = `translate(${x * 30} ${y * 18})`;
      eyes.forEach((g) => set(g, et));
      svg.classList.toggle('squint', near && mode === 'watch' && now >= happyUntil);

      requestAnimationFrame(tick);
    }
    start();

    const api = {
      happy() {
        if (mode !== 'watch' && mode !== 'turn') return;
        happyUntil = performance.now() + 1600;
        svg.classList.add('happy');
        clearTimeout(api._h);
        api._h = setTimeout(() => svg.classList.remove('happy'), 1600);
      },
      setState(next) {
        mode = next;
        stateSince = performance.now();
        svg.classList.remove('blink', 'squint');
        // a smile still running from before must not show over the work, alert or sleep face
        if (next !== 'watch' && next !== 'turn') { happyUntil = 0; clearTimeout(api._h); svg.classList.remove('happy'); }
        if (next === 'turn') hopUntil = stateSince + 1000;
      },
      lookAt(el) {
        const b = el.getBoundingClientRect();
        if (b.width) onPoint(b.left + b.width / 2, b.top + b.height / 2);
      },
    };
    return api;
  }

  function set(el, tf) { if (el) el.setAttribute('transform', tf); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
})();
