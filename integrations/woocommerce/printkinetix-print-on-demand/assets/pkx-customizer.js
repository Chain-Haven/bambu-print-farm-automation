// PrintKinetix customizer — builds the finishing controls (and optional 3D
// preview) on WooCommerce product pages for print-on-demand products, and
// keeps the hidden form inputs in sync so the choices ride the cart item.
(function () {
  'use strict';

  var COLORS = [
    ['Any', ''], ['White', '#F5F5F0'], ['Black', '#101010'], ['Gray', '#9E9E9E'],
    ['Red', '#D32F2F'], ['Orange', '#F57C00'], ['Yellow', '#FBC02D'],
    ['Green', '#388E3C'], ['Blue', '#1976D2'], ['Teal', '#0F766E'], ['Purple', '#7B1FA2'],
  ];

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (key) {
      if (key === 'style') node.style.cssText = attrs[key];
      else if (key === 'text') node.textContent = attrs[key];
      else node.setAttribute(key, attrs[key]);
    });
    (children || []).forEach(function (child) { node.appendChild(child); });
    return node;
  }

  function init() {
    var root = document.getElementById('pkx-customizer');
    if (!root) return;
    var config = window.pkxPodConfig || {};
    var inputs = {
      material: root.querySelector('input[name="pkx_material"]'),
      color: root.querySelector('input[name="pkx_color"]'),
      scale: root.querySelector('input[name="pkx_scale"]'),
      infill: root.querySelector('input[name="pkx_infill"]'),
      quality: root.querySelector('input[name="pkx_quality"]'),
    };
    var viewer = null;

    root.appendChild(el('style', {
      text: '#pkx-customizer{margin:14px 0;padding:14px;border:1px solid #ddd;border-radius:10px}' +
        '#pkx-customizer h4{margin:10px 0 6px;font-size:14px}' +
        '#pkx-customizer .pkx-swatch{width:24px;height:24px;border-radius:50%;border:2px solid #ccc;display:inline-block;margin-right:6px;cursor:pointer;vertical-align:middle}' +
        '#pkx-customizer .pkx-swatch.sel{border-color:#0f766e;box-shadow:0 0 0 2px rgba(15,118,110,.35)}' +
        '#pkx-customizer select,#pkx-customizer input[type=range]{max-width:100%}' +
        '#pkx-viewer-canvas{width:100%;height:280px;border:1px solid #e3e3e3;border-radius:8px;touch-action:none;display:block}',
    }));

    // Optional interactive 3D preview (merchant provides an STL/OBJ URL).
    if (config.previewUrl && window.PKXModelViewer) {
      var canvas = el('canvas', { id: 'pkx-viewer-canvas', 'aria-label': '3D preview' });
      root.appendChild(el('h4', { text: 'Preview — drag to rotate, scroll to zoom' }));
      root.appendChild(canvas);
      fetch(config.previewUrl).then(function (response) {
        return config.previewUrl.toLowerCase().indexOf('.obj') !== -1 ? response.text() : response.arrayBuffer();
      }).then(function (data) {
        var positions = typeof data === 'string'
          ? window.PKXModelViewer.parseOBJ(data)
          : window.PKXModelViewer.parseSTL(data);
        if (!positions) return;
        viewer = window.PKXModelViewer.createModelViewer(canvas);
        if (viewer) viewer.loadPositions(positions);
      }).catch(function () { /* preview is optional */ });
    }

    // Material.
    root.appendChild(el('h4', { text: 'Material' }));
    var materialSelect = el('select', {});
    (config.materials && config.materials.length ? config.materials : ['PLA', 'PETG']).forEach(function (material) {
      materialSelect.appendChild(el('option', { value: material, text: material }));
    });
    materialSelect.addEventListener('change', function () { inputs.material.value = materialSelect.value; });
    inputs.material.value = materialSelect.value;
    root.appendChild(materialSelect);

    // Color swatches.
    root.appendChild(el('h4', { text: 'Color' }));
    var swatchWrap = el('div', {});
    COLORS.forEach(function (pair, index) {
      var swatch = el('span', {
        class: 'pkx-swatch' + (index === 0 ? ' sel' : ''),
        title: pair[0],
        role: 'button',
        tabindex: '0',
        style: pair[1] ? 'background:' + pair[1] : 'background:conic-gradient(#e66 0 25%,#6b6 0 50%,#66d 0 75%,#dd6 0)',
      });
      function select() {
        inputs.color.value = pair[1];
        swatchWrap.querySelectorAll('.pkx-swatch').forEach(function (other) { other.classList.remove('sel'); });
        swatch.classList.add('sel');
        if (viewer) viewer.setColor(pair[1] || '#6BC0AE');
      }
      swatch.addEventListener('click', select);
      swatch.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(); }
      });
      swatchWrap.appendChild(swatch);
    });
    root.appendChild(swatchWrap);

    // Scale.
    root.appendChild(el('h4', { text: 'Size' }));
    var scaleLabel = el('span', { text: '100%' , style: 'margin-left:8px;font-weight:600' });
    var scale = el('input', { type: 'range', min: '50', max: '200', step: '5', value: '100', style: 'width:70%' });
    scale.addEventListener('input', function () {
      inputs.scale.value = scale.value;
      scaleLabel.textContent = scale.value + '%';
    });
    root.appendChild(scale);
    root.appendChild(scaleLabel);

    // Strength + quality.
    root.appendChild(el('h4', { text: 'Strength & quality' }));
    var infill = el('select', {});
    [['light', 'Light — decorative'], ['standard', 'Standard'], ['strong', 'Strong — functional']].forEach(function (pair) {
      infill.appendChild(el('option', { value: pair[0], text: pair[1] }));
    });
    infill.value = 'standard';
    infill.addEventListener('change', function () { inputs.infill.value = infill.value; });
    var quality = el('select', { style: 'margin-left:8px' });
    [['draft', 'Draft — fastest'], ['standard', 'Standard'], ['fine', 'Fine — smoothest']].forEach(function (pair) {
      quality.appendChild(el('option', { value: pair[0], text: pair[1] }));
    });
    quality.value = 'standard';
    quality.addEventListener('change', function () { inputs.quality.value = quality.value; });
    root.appendChild(infill);
    root.appendChild(quality);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
