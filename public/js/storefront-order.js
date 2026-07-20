// public/js/storefront-order.js — the /order self-service funnel.
// Step 1: file + material + qty -> POST /api/public/storefront/quote
// Step 2: contact + address     -> POST /api/public/storefront/checkout
//         -> redirect to Stripe (or straight to the status view offline)
// Status: /order?order_id=..&token=.. polls GET /api/public/storefront/orders
(() => {
  const $ = (selector) => document.querySelector(selector);
  const MAX_FILE_BYTES = 25 * 1024 * 1024;

  const FILAMENT_COLORS = [
    ['Any color', null],
    ['White', '#F5F5F0'],
    ['Black', '#101010'],
    ['Gray', '#9E9E9E'],
    ['Red', '#D32F2F'],
    ['Orange', '#F57C00'],
    ['Yellow', '#FBC02D'],
    ['Green', '#388E3C'],
    ['Blue', '#1976D2'],
    ['Teal', '#0F766E'],
    ['Purple', '#7B1FA2'],
  ];

  const state = {
    file: null,        // { name, base64, byteSize }
    quote: null,
    quoteToken: null,
    paymentsConfigured: false,
    unpaidAllowed: false,
    viewer: null,
    meshBounds: null,
    finish: { scale_percent: 100, color_hex: null, infill: 'standard', quality: 'standard' },
  };

  // Base64 without readAsDataURL so the same ArrayBuffer also feeds the 3D
  // viewer. Chunked to keep String.fromCharCode off the stack limit.
  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunks = [];
    for (let i = 0; i < bytes.length; i += 0x8000) {
      chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)));
    }
    return btoa(chunks.join(''));
  }

  function formatDims(bounds, scalePercent) {
    if (!bounds) return '—';
    const factor = (scalePercent || 100) / 100;
    const [x, y, z] = bounds.size.map((value) => (value * factor).toFixed(value * factor >= 100 ? 0 : 1));
    return `${x} × ${y} × ${z} mm at ${scalePercent}%`;
  }

  function updateDims() {
    $('#model-dims').textContent = formatDims(state.meshBounds, state.finish.scale_percent);
  }

  // Any option that affects the print invalidates the current price.
  function markQuoteStale() {
    if (!state.quoteToken) return;
    state.quoteToken = null;
    $('#stale-banner').hidden = false;
    $('#checkout-btn').disabled = true;
  }

  function showModelInViewer(arrayBuffer, fileName) {
    const viewerCard = $('#viewer-card');
    const lower = fileName.toLowerCase();
    const isSliced = lower.endsWith('.gcode') || lower.endsWith('.gcode.3mf');
    let positions = null;
    try {
      if (lower.endsWith('.stl')) positions = window.PKXModelViewer.parseSTL(arrayBuffer);
      else if (lower.endsWith('.obj')) positions = window.PKXModelViewer.parseOBJ(new TextDecoder().decode(arrayBuffer));
    } catch { positions = null; }

    if (!positions) {
      state.meshBounds = null;
      // Still show finishing options for other source formats; sliced files
      // are geometry-frozen, so nothing to adjust.
      viewerCard.hidden = isSliced;
      $('#viewer-sub').textContent = isSliced
        ? ''
        : 'No 3D preview for this format — finishing options below still apply.';
      document.querySelector('.viewer-wrap').hidden = true;
      $('#finish-panel').hidden = isSliced;
      return;
    }

    document.querySelector('.viewer-wrap').hidden = false;
    $('#finish-panel').hidden = false;
    $('#viewer-sub').textContent = 'Drag to rotate · scroll or pinch to zoom. This is the exact geometry we\'ll print.';
    viewerCard.hidden = false;
    if (!state.viewer) {
      state.viewer = window.PKXModelViewer.createModelViewer($('#model-canvas'));
      if (!state.viewer) { // WebGL unavailable
        document.querySelector('.viewer-wrap').hidden = true;
        return;
      }
    }
    state.meshBounds = state.viewer.loadPositions(positions);
    state.viewer.setColor(state.finish.color_hex || '#6BC0AE');
    updateDims();
  }

  function money(cents, currency = 'USD') {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format((cents || 0) / 100);
  }

  function showError(target, message) {
    const el = $(target);
    el.hidden = !message;
    el.textContent = message || '';
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      method: options.method || 'GET',
      headers: options.body ? { 'Content-Type': 'application/json' } : {},
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.message || payload.error || `Request failed (${response.status})`);
    }
    return payload;
  }

  // ---------------------------------------------------------------- file pick
  const dropZone = $('#drop-zone');
  const fileInput = $('#file-input');

  function setFile(file) {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      showError('#quote-error', `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB — the limit is 25 MB.`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const buffer = reader.result;
      state.file = { name: file.name, base64: arrayBufferToBase64(buffer), byteSize: file.size };
      $('#file-name').textContent = `${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`;
      showError('#quote-error', '');
      markQuoteStale();
      showModelInViewer(buffer, file.name);
    };
    reader.onerror = () => showError('#quote-error', 'Could not read that file — try again.');
    reader.readAsArrayBuffer(file);
  }

  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') fileInput.click();
  });
  fileInput.addEventListener('change', () => setFile(fileInput.files[0]));
  ['dragover', 'dragleave', 'drop'].forEach((type) => {
    dropZone.addEventListener(type, (event) => {
      event.preventDefault();
      dropZone.classList.toggle('dragover', type === 'dragover');
      if (type === 'drop') setFile(event.dataTransfer.files[0]);
    });
  });

  // ------------------------------------------------------- finishing touches
  function buildSwatches() {
    const wrap = $('#color-swatches');
    for (const [name, hex] of FILAMENT_COLORS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `swatch${hex === null ? ' selected' : ''}`;
      button.title = name;
      button.setAttribute('aria-label', `Color: ${name}`);
      button.style.background = hex || 'conic-gradient(#e66 0 25%, #6b6 0 50%, #66d 0 75%, #dd6 0)';
      button.addEventListener('click', () => {
        state.finish.color_hex = hex;
        wrap.querySelectorAll('.swatch').forEach((el) => el.classList.remove('selected'));
        button.classList.add('selected');
        if (state.viewer) state.viewer.setColor(hex || '#6BC0AE');
        markQuoteStale(); // color routes the job; keep quote + order in sync
      });
      wrap.append(button);
    }
  }
  buildSwatches();

  function setScale(value) {
    const scale = Math.min(Math.max(Math.round(Number(value) || 100), 25), 400);
    state.finish.scale_percent = scale;
    $('#finish-scale').value = String(scale);
    $('#finish-scale-num').value = String(scale);
    $('#scale-label').textContent = `${scale}%`;
    updateDims();
    markQuoteStale();
  }
  $('#finish-scale').addEventListener('input', (event) => setScale(event.target.value));
  $('#finish-scale-num').addEventListener('change', (event) => setScale(event.target.value));
  $('#finish-infill').addEventListener('change', (event) => {
    state.finish.infill = event.target.value;
    markQuoteStale();
  });
  $('#finish-quality').addEventListener('change', (event) => {
    state.finish.quality = event.target.value;
    markQuoteStale();
  });
  $('#viewer-reset')?.addEventListener('click', () => state.viewer?.resetView());
  $('#material').addEventListener('change', markQuoteStale);
  $('#quantity').addEventListener('change', markQuoteStale);

  // -------------------------------------------------------------------- quote
  function renderQuote(payload) {
    state.quote = payload.quote;
    state.quoteToken = payload.quote_token;
    state.paymentsConfigured = payload.payments?.configured === true;
    state.unpaidAllowed = payload.payments?.unpaid_orders_allowed === true;

    const quote = payload.quote;
    const currency = quote.currency;
    const finishBits = [];
    if (state.finish.scale_percent !== 100) finishBits.push(`${state.finish.scale_percent}% size`);
    if (state.finish.color_hex) finishBits.push(`color ${state.finish.color_hex}`);
    if (state.finish.infill !== 'standard') finishBits.push(`${state.finish.infill} infill`);
    if (state.finish.quality !== 'standard') finishBits.push(`${state.finish.quality} quality`);
    $('#quote-meta').textContent =
      `${quote.quantity} × ${payload.file.name} in ${quote.material}${finishBits.length ? ` (${finishBits.join(', ')})` : ''} — `
      + `about ${quote.estimates.grams_per_piece} g and ${Math.round(quote.estimates.print_minutes_per_piece / 60 * 10) / 10} h of printing per piece.`;
    $('#stale-banner').hidden = true;
    $('#checkout-btn').disabled = false;

    const lines = [
      [`Printing (${quote.quantity} × ${money(quote.totals.unit_cents, currency)})`, quote.totals.unit_cents * quote.quantity],
      ['Setup', quote.totals.setup_cents],
      ...(quote.totals.markup_cents > 0 ? [['Service', quote.totals.markup_cents]] : []),
      ['Shipping (tracked)', quote.totals.shipping_cents],
    ];
    $('#price-lines').innerHTML = '';
    for (const [label, cents] of lines) {
      const li = document.createElement('li');
      li.innerHTML = `<span></span><span></span>`;
      li.children[0].textContent = label;
      li.children[1].textContent = money(cents, currency);
      $('#price-lines').append(li);
    }
    const total = document.createElement('li');
    total.className = 'total';
    total.innerHTML = '<span>Total</span><span></span>';
    total.children[1].textContent = money(quote.totals.total_cents, currency);
    $('#price-lines').append(total);

    const basis = {
      slicer_metadata: 'Exact material use read from your sliced file.',
      mesh_volume: 'Material measured from your model\'s mesh volume (walls + infill).',
      file_size_heuristic: 'Rough estimate — this format is priced precisely after slicing; we\'ll contact you if it differs.',
    }[quote.estimates.estimate_basis] || '';
    $('#quote-basis').textContent = `${basis} Quote valid until ${new Date(payload.quote_expires_at).toLocaleTimeString()}.`;

    $('#quote-card').hidden = false;
    $('#checkout-card').hidden = false;
    $('#step-2').classList.add('active');
    $('#checkout-btn').textContent = state.paymentsConfigured
      ? `Pay ${money(quote.totals.total_cents, currency)} & print`
      : 'Place order';
    $('#payment-hint').textContent = state.paymentsConfigured
      ? 'You\'ll be redirected to Stripe\'s secure checkout to pay.'
      : (state.unpaidAllowed
        ? 'Online payment isn\'t configured — the order is placed and the operator will arrange payment.'
        : 'Online payment isn\'t configured yet — ordering is disabled until the operator adds Stripe keys.');
    $('#quote-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  $('#quote-btn').addEventListener('click', async () => {
    if (!state.file) {
      showError('#quote-error', 'Choose a 3D file first.');
      return;
    }
    const button = $('#quote-btn');
    button.disabled = true;
    button.textContent = 'Pricing…';
    showError('#quote-error', '');
    try {
      const payload = await api('/api/public/storefront/quote', {
        method: 'POST',
        body: {
          file: { name: state.file.name, base64: state.file.base64 },
          material: $('#material').value,
          quantity: Number($('#quantity').value) || 1,
          finish: state.finish,
        },
      });
      renderQuote(payload);
    } catch (error) {
      showError('#quote-error', error.message);
    } finally {
      button.disabled = false;
      button.textContent = 'Get instant price';
    }
  });

  // ----------------------------------------------------------------- checkout
  $('#checkout-btn').addEventListener('click', async () => {
    if (!state.file || !state.quoteToken) {
      showError('#checkout-error', 'Get a price first.');
      return;
    }
    const button = $('#checkout-btn');
    button.disabled = true;
    showError('#checkout-error', '');
    try {
      const payload = await api('/api/public/storefront/checkout', {
        method: 'POST',
        body: {
          file: { name: state.file.name, base64: state.file.base64 },
          material: $('#material').value,
          quantity: Number($('#quantity').value) || 1,
          finish: state.finish,
          quote_token: state.quoteToken,
          email: $('#ship-email').value.trim(),
          name: $('#ship-name').value.trim(),
          shipping_address: {
            line1: $('#ship-line1').value.trim(),
            line2: $('#ship-line2').value.trim() || null,
            city: $('#ship-city').value.trim(),
            region: $('#ship-region').value.trim() || null,
            postal_code: $('#ship-postal').value.trim(),
            country: $('#ship-country').value.trim().toUpperCase(),
          },
        },
      });
      if (payload.checkout_url && payload.status === 'pending_payment') {
        window.location.href = payload.checkout_url; // Stripe hosted checkout
        return;
      }
      window.location.href = payload.status_url; // offline/mock: straight to status
    } catch (error) {
      showError('#checkout-error', error.message);
      button.disabled = false;
    }
  });

  // ------------------------------------------------------------------- status
  const params = new URLSearchParams(window.location.search);
  const orderId = params.get('order_id');
  const orderToken = params.get('token');

  const STATUS_LABELS = {
    pending_payment: ['Awaiting payment', 'warn'],
    paid: ['Paid — queued for printing', 'ok'],
    processing: ['Printing at the farm', 'ok'],
    ready_to_ship: ['Printed — preparing shipment', 'ok'],
    shipped: ['Shipped', 'ok'],
    payment_expired: ['Payment expired — order not placed', 'err'],
    canceled: ['Canceled', 'err'],
    refunded: ['Canceled — refunded', 'err'],
  };
  const CANCELABLE_STATUSES = new Set(['pending_payment', 'paid', 'processing']);

  async function refreshStatus() {
    try {
      const payload = await api(`/api/public/storefront/orders?order_id=${encodeURIComponent(orderId)}&token=${encodeURIComponent(orderToken)}`);
      const order = payload.order;
      const [label, tone] = STATUS_LABELS[order.status] || [order.status, ''];
      const chip = $('#status-chip');
      chip.textContent = label;
      chip.className = `status-chip ${tone}`;

      // Progress timeline: Paid → Printing → Done & shipping.
      const jobStatuses = order.jobs.map((job) => String(job.status || '').toLowerCase());
      const allDone = order.status === 'shipped' || order.status === 'ready_to_ship'
        || (jobStatuses.length > 0 && jobStatuses.every((status) => ['completed', 'complete', 'finished'].includes(status)));
      const anyPrinting = jobStatuses.some((status) => ['printing', 'queued', 'assigned', 'transforming', 'uploading'].includes(status));
      const stepStates = {
        paid: order.paid_at ? 'done' : (order.status === 'pending_payment' ? 'now' : ''),
        printing: allDone ? 'done' : (anyPrinting || order.status === 'processing' ? 'now' : ''),
        done: order.status === 'shipped' ? 'done' : (allDone ? 'now' : ''),
      };
      document.querySelectorAll('#status-timeline .tstep').forEach((el) => {
        el.classList.remove('done', 'now');
        const stepState = stepStates[el.dataset.step];
        if (stepState) el.classList.add(stepState);
      });
      $('#status-order-id').textContent = `Order ${order.order_id.slice(-10)}`;
      $('#status-summary').textContent =
        `${order.quantity} × ${order.file_name} in ${order.material}, placed ${new Date(order.created_at).toLocaleString()}.`;

      const lines = $('#status-price-lines');
      lines.innerHTML = '';
      const total = document.createElement('li');
      total.className = 'total';
      total.innerHTML = '<span>Total</span><span></span>';
      total.children[1].textContent = money(order.quote?.totals?.total_cents, order.quote?.currency);
      lines.append(total);

      const jobs = $('#status-jobs');
      jobs.innerHTML = '';
      if (!order.jobs.length) {
        const li = document.createElement('li');
        li.textContent = order.status === 'pending_payment'
          ? 'Jobs are created as soon as payment completes.'
          : 'Queued — jobs appear here within a minute.';
        jobs.append(li);
      }
      for (const [index, job] of order.jobs.entries()) {
        const li = document.createElement('li');
        li.innerHTML = '<span></span><span></span>';
        li.children[0].textContent = `Piece ${index + 1}`;
        li.children[1].textContent = job.status.replace(/_/g, ' ');
        jobs.append(li);
      }
      const address = order.shipping_address || {};
      $('#status-shipping').textContent =
        `Ships to: ${[address.line1, address.line2, address.city, address.region, address.postal_code, address.country].filter(Boolean).join(', ')}`;

      const tracking = $('#status-tracking');
      if (order.shipment?.tracking_code) {
        tracking.hidden = false;
        tracking.textContent = `📦 ${order.shipment.carrier || 'Carrier'} ${order.shipment.service || ''} — tracking ${order.shipment.tracking_code}`;
      } else {
        tracking.hidden = true;
      }

      $('#status-cancel').hidden = !CANCELABLE_STATUSES.has(order.status);
      showError('#status-error', '');
    } catch (error) {
      showError('#status-error', error.message);
    }
  }

  if (orderId && orderToken) {
    $('#funnel-view').hidden = true;
    $('#status-view').hidden = false;
    if (params.get('canceled')) {
      $('#status-lead').textContent = 'Payment was canceled — you can retry from a fresh quote. This page stays live for this order.';
    }
    refreshStatus();
    setInterval(refreshStatus, 8000);
    $('#status-refresh').addEventListener('click', refreshStatus);
    $('#status-cancel').addEventListener('click', async () => {
      if (!window.confirm('Cancel this order? If you already paid, a full refund is issued. This is only possible before printing starts.')) return;
      const button = $('#status-cancel');
      button.disabled = true;
      try {
        await api('/api/public/storefront/cancel', {
          method: 'POST',
          body: { order_id: orderId, token: orderToken },
        });
        await refreshStatus();
      } catch (error) {
        showError('#status-error', error.message);
      } finally {
        button.disabled = false;
      }
    });
  }
})();
