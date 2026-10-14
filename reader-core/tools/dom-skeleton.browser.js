/*
 * Paste this whole file into the browser DevTools Console on a page you are logged in to.
 * It prints the page's *structure* — tags, classes, roles, repeated blocks — and no text.
 * Optional: set `window.__domSkeletonOptions = { selector: '#root', maxDepth: 14 }` first.
 * Nothing is sent anywhere; it only returns/prints a string (and calls DevTools' copy() if present).
 */
(function () {
  var o = Object.assign({ selector: 'body', maxDepth: 12, maxClasses: 6 }, window.__domSkeletonOptions || {});
  var root = document.querySelector(o.selector) || document.body;
  var OPAQUE = /\d{4,}|[0-9a-f]{7,}/i; // hashed css-module classes, generated ids, row keys
  var OPAQUE_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, CANVAS: 1, IFRAME: 1 };

  function signature(el) {
    var s = el.tagName.toLowerCase();
    var id = el.getAttribute('id');
    if (id) s += '#' + (OPAQUE.test(id) ? ':id' : id);
    var classes = Array.prototype.slice.call(el.classList).map(function (c) { return OPAQUE.test(c) ? ':hash' : c; });
    classes = classes.filter(function (c, i) { return classes.indexOf(c) === i; }).slice(0, o.maxClasses);
    if (classes.length) s += '.' + classes.join('.');
    var attrs = [];
    var role = el.getAttribute('role');
    if (role) attrs.push('role=' + role);
    Array.prototype.forEach.call(el.attributes, function (a) {
      if (/^(aria-|data-)/.test(a.name)) attrs.push(a.name); // names only, never values
    });
    if (el.getAttribute('contenteditable') !== null) attrs.push('contenteditable');
    if (attrs.length) s += '[' + attrs.join(' ') + ']';
    var ownText = Array.prototype.some.call(el.childNodes, function (n) { return n.nodeType === 3 && /\S/.test(n.nodeValue); });
    return ownText ? s + ' "…"' : s;
  }

  function render(el, depth) {
    var head = signature(el);
    if (OPAQUE_TAGS[el.tagName.toUpperCase()] || depth >= o.maxDepth || !el.children.length) return [head];
    var groups = [];
    Array.prototype.forEach.call(el.children, function (child) {
      var lines = render(child, depth + 1);
      var key = lines.join('\n');
      var last = groups[groups.length - 1];
      if (last && last.key === key) last.n++;
      else groups.push({ key: key, lines: lines, n: 1 });
    });
    var out = [head];
    groups.forEach(function (g) {
      g.lines.forEach(function (line, i) { out.push('  ' + line + (i === 0 && g.n > 1 ? '  ×' + g.n : '')); });
    });
    return out;
  }

  var result = render(root, 0).join('\n');
  try { if (typeof copy === 'function') copy(result); } catch (e) { /* not in DevTools */ }
  console.log(result);
  return result;
})();
