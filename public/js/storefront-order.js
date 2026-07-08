// public/js/storefront-order.js — the /order self-service funnel.
// Step 1: file + material + qty -> POST /api/public/storefront/quote
// Step 2: contact + address     -> POST /api/public/storefront/checkout
//         -> redirect to Stripe (or straight to the status view offline)
// Status: /order?order_id=..&token=.. polls GET /api/public/storefront/orders
(() => {
  const $ = (selector) => document.querySelector(selector);
  const MAX_FILE_BYTES = 25 * 1024 * 1024;

  const state = {
    file: null,        // { name, base64, byteSize }
    quote: null,
    quoteToken: null,
    paymentsConfigured: false,
    unpaidAllowed: false,
  };

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
      const base64 = String(reader.result).split(',')[1] || '';
      state.file = { name: file.name, base64, byteSize: file.size };
      $('#file-name').textContent = `${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`;
      showError('#quote-error', '');
    };
    reader.onerror = () => showError('#quote-error', 'Could not read that file — try again.');
    reader.readAsDataURL(file);
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

  // -------------------------------------------------------------------- quote
  function renderQuote(payload) {
    state.quote = payload.quote;
    state.quoteToken = payload.quote_token;
    state.paymentsConfigured = payload.payments?.configured === true;
    state.unpaidAllowed = payload.payments?.unpaid_orders_allowed === true;

    const quote = payload.quote;
    const currency = quote.currency;
    $('#quote-meta').textContent =
      `${quote.quantity} × ${payload.file.name} in ${quote.material} — about ${quote.estimates.grams_per_piece} g `
      + `and ${Math.round(quote.estimates.print_minutes_per_piece / 60 * 10) / 10} h of printing per piece.`;

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
    payment_expired: ['Payment expired — order not placed', 'err'],
  };

  async function refreshStatus() {
    try {
      const payload = await api(`/api/public/storefront/orders?order_id=${encodeURIComponent(orderId)}&token=${encodeURIComponent(orderToken)}`);
      const order = payload.order;
      const [label, tone] = STATUS_LABELS[order.status] || [order.status, ''];
      const chip = $('#status-chip');
      chip.textContent = label;
      chip.className = `status-chip ${tone}`;
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
  }
})();
