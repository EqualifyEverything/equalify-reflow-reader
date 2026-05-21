/*
 * Equalify Reflow Reader — bookmarklet source
 * ------------------------------------------------------------------
 * A single bookmarklet. When triggered on a PDF, it:
 *   1. Cleans the current URL and opens a new window.
 *   2. Injects the entire reader app (`runReader`) INTO that window so the
 *      reader keeps running even if the original tab is closed.
 *   3. Fetches the PDF bytes, uploads them to the Equalify Reflow API,
 *      polls for completion (gating on PII), then renders the returned
 *      markdown as accessible, screen-reader-friendly HTML.
 *
 * This file is the human-readable source. `build.py` wraps it into the
 * `javascript:` one-liner in dist/bookmarklet.txt.
 *
 * API: https://reflow.equalify.uic.edu/docs  (every /api/v1/* call needs an
 * X-API-Key header; CORS is open and allows that header from any origin.)
 */
(function bootstrap() {
  'use strict';

  // ---- Loader (runs in the page the user triggered the bookmarklet on) ----

  // Strip fragment + common tracking junk that Acrobat / extensions append.
  function cleanPdfUrl(href) {
    try {
      var u = new URL(href);
      u.hash = '';
      var drop = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term',
        'utm_content', 'fbclid', 'gclid', 'mc_cid', 'mc_eid'];
      drop.forEach(function (k) { u.searchParams.delete(k); });
      return u.toString();
    } catch (e) {
      return href.split('#')[0];
    }
  }

  var pdfUrl = cleanPdfUrl(window.location.href);
  var win = window.open('', 'EqualifyReflowReader_' + Date.now());
  if (!win) {
    window.alert('Equalify Reflow Reader could not open a new window. Please allow pop-ups for this site and try again.');
    return;
  }

  // Minimal accessible shell; the injected app fills in the rest.
  win.document.open();
  win.document.write(
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Remediating PDF…</title></head><body>' +
    '<p style="font:16px/1.5 system-ui,sans-serif;padding:1rem">Starting Equalify Reflow Reader…</p>' +
    '</body></html>'
  );
  win.document.close();

  // Inject the app into the new window's own JS context so it is independent
  // of this opener tab. The app is same-origin with this page, so this is
  // allowed and the app can read same-origin PDF bytes via fetch().
  var cfg = { pdfUrl: pdfUrl, api: 'https://reflow.equalify.uic.edu' };
  var script = win.document.createElement('script');
  script.textContent = '(' + runReader.toString() + ')(' + JSON.stringify(cfg) + ');';
  win.document.head.appendChild(script);

  // ==================================================================
  // The reader app. Everything below runs INSIDE the new window.
  // It must be fully self-contained (no references to bootstrap's scope).
  // ==================================================================
  function runReader(cfg) {
    'use strict';
    var API = cfg.api;
    var PDF_URL = cfg.pdfUrl;
    var KEY_STORE = 'equalify_reflow_api_key';
    var EMAIL_STORE = 'equalify_reflow_reviewer_email';
    var doc = document;

    var state = {
      apiKey: localStorage.getItem(KEY_STORE) || '',
      reviewerEmail: localStorage.getItem(EMAIL_STORE) || '',
      jobId: null,
      filename: null,
      poll: null
    };

    // ---------- tiny DOM helpers ----------
    function el(tag, attrs, kids) {
      var n = doc.createElement(tag);
      if (attrs) Object.keys(attrs).forEach(function (k) {
        if (k === 'text') n.textContent = attrs[k];
        else if (k === 'html') n.innerHTML = attrs[k];
        else if (k.indexOf('aria') === 0 || k === 'role' || k === 'for')
          n.setAttribute(k === 'for' ? 'for' : k, attrs[k]);
        else n[k] = attrs[k];
      });
      (kids || []).forEach(function (c) {
        n.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c);
      });
      return n;
    }
    function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

    // ---------- page chrome (built once) ----------
    function buildChrome() {
      doc.documentElement.lang = 'en';
      clear(doc.body);
      doc.head.appendChild(el('style', { text: STYLES }));

      var skip = el('a', { href: '#main', className: 'reflow-skip', text: 'Skip to document' });

      var status = el('p', { id: 'reflow-status', role: 'status', 'aria-live': 'polite' });
      var header = el('header', { className: 'reflow-bar' }, [
        el('h1', { text: 'Equalify Reflow Reader' }),
        el('div', { id: 'reflow-actions', className: 'reflow-actions' })
      ]);

      var main = el('main', { id: 'main', tabIndex: -1 });
      var live = el('div', { id: 'reflow-error', role: 'alert', className: 'reflow-error', hidden: true });

      doc.body.appendChild(skip);
      doc.body.appendChild(header);
      doc.body.appendChild(status);
      doc.body.appendChild(live);
      doc.body.appendChild(main);
    }

    function setTitle(t) { doc.title = t; }
    function setStatus(msg) {
      var s = doc.getElementById('reflow-status');
      if (s) s.textContent = msg;
    }
    function showError(msg, detail) {
      var box = doc.getElementById('reflow-error');
      clear(box);
      box.hidden = false;
      box.appendChild(el('strong', { text: 'Something went wrong. ' }));
      box.appendChild(doc.createTextNode(msg));
      if (detail) box.appendChild(el('pre', { text: String(detail) }));
      box.focus && box.focus();
    }
    function clearError() {
      var box = doc.getElementById('reflow-error');
      if (box) { box.hidden = true; clear(box); }
    }

    // ---------- API key / reviewer email gate ----------
    function ensureCredentials(next) {
      if (state.apiKey && state.reviewerEmail) { next(); return; }
      var main = doc.getElementById('main');
      clear(main);
      setStatus('Credentials needed.');

      var keyInput = el('input', {
        id: 'reflow-key', type: 'password', value: state.apiKey,
        autocomplete: 'off', spellcheck: false
      });
      var emailInput = el('input', {
        id: 'reflow-email', type: 'email', value: state.reviewerEmail, autocomplete: 'email'
      });

      var form = el('form', { className: 'reflow-card' }, [
        el('h2', { text: 'Connect to Equalify Reflow' }),
        el('p', { text: 'These are stored only in this browser (localStorage) and sent to the Reflow API.' }),
        el('label', { for: 'reflow-key', text: 'Reflow API key (X-API-Key)' }),
        keyInput,
        el('label', { for: 'reflow-email', text: 'Your email (used when approving PII)' }),
        emailInput,
        el('button', { type: 'submit', className: 'reflow-btn', text: 'Save and continue' })
      ]);
      form.onsubmit = function (e) {
        e.preventDefault();
        var k = keyInput.value.trim(), m = emailInput.value.trim();
        if (!k) { showError('An API key is required.'); keyInput.focus(); return; }
        if (m.length < 3) { showError('A valid email is required for PII approval.'); emailInput.focus(); return; }
        state.apiKey = k; state.reviewerEmail = m;
        localStorage.setItem(KEY_STORE, k);
        localStorage.setItem(EMAIL_STORE, m);
        clearError();
        next();
      };
      main.appendChild(form);
      keyInput.focus();
    }

    function authHeaders(extra) {
      var h = { 'X-API-Key': state.apiKey };
      if (extra) Object.keys(extra).forEach(function (k) { h[k] = extra[k]; });
      return h;
    }

    // ---------- pipeline ----------
    function start() {
      clearError();
      setStatus('Fetching the PDF…');
      setTitle('Remediating PDF…');
      fetchPdf()
        .then(submit)
        .then(function (job) {
          state.jobId = job.job_id;
          setStatus('Uploaded. Processing…');
          beginPolling();
        })
        .catch(function (err) {
          if (err && err.authFailed) {
            state.apiKey = '';
            localStorage.removeItem(KEY_STORE);
            ensureCredentials(start);
            showError('The API key was rejected. Please re-enter it.');
            return;
          }
          if (err && err.pdfFetch) {
            showError(
              'The PDF could not be fetched from its URL. This usually means the ' +
              'document is on a different site that blocks cross-origin reads (CORS). ' +
              'Open the PDF directly in a tab, then run the bookmarklet there.',
              PDF_URL
            );
            return;
          }
          showError('Could not submit the document.', err && err.message);
        });
    }

    function fetchPdf() {
      return fetch(PDF_URL, { credentials: 'omit' })
        .then(function (r) {
          if (!r.ok) throw tag({ message: 'HTTP ' + r.status }, 'pdfFetch');
          return r.blob();
        })
        .then(function (blob) {
          if (blob.type && blob.type.indexOf('pdf') === -1 && blob.type.indexOf('octet') === -1) {
            // Not obviously a PDF, but proceed — some servers mislabel.
          }
          state.filename = guessName(PDF_URL);
          return blob;
        })
        .catch(function (e) { throw e.pdfFetch ? e : tag(e, 'pdfFetch'); });
    }

    function submit(blob) {
      var fd = new FormData();
      fd.append('file', blob, state.filename || 'document.pdf');
      fd.append('review_mode', 'auto');
      return fetch(API + '/api/v1/documents/submit', {
        method: 'POST', headers: authHeaders(), body: fd
      }).then(handleJson);
    }

    function beginPolling() {
      var tick = function () {
        fetch(API + '/api/v1/documents/' + encodeURIComponent(state.jobId), {
          headers: authHeaders()
        }).then(handleJson).then(onStatus).catch(function (err) {
          stopPolling();
          showError('Lost contact with the processing job.', err && err.message);
        });
      };
      tick();
      state.poll = setInterval(tick, 2500);
    }
    function stopPolling() { if (state.poll) { clearInterval(state.poll); state.poll = null; } }

    function onStatus(job) {
      switch (job.status) {
        case 'pii_scanning':
          setStatus('Scanning for personally identifiable information…');
          break;
        case 'processing':
          var phase = job.processing_phase ? ' (' + job.processing_phase + ')' : '';
          var prog = (job.jobs_total)
            ? ' — ' + (job.jobs_complete || 0) + ' of ' + job.jobs_total + ' steps'
            : '';
          setStatus('Making the document accessible' + phase + prog + '…');
          break;
        case 'awaiting_approval':
          stopPolling();
          showPiiGate(job);
          break;
        case 'completed':
          stopPolling();
          loadResult(job);
          break;
        case 'denied':
          stopPolling();
          renderDenied(job.reason);
          break;
        case 'failed':
          stopPolling();
          showError('Processing failed.', job.error);
          break;
        default:
          setStatus('Working… (' + job.status + ')');
      }
    }

    // ---------- PII gate ----------
    function showPiiGate(job) {
      setStatus('Personally identifiable information was detected.');
      var main = doc.getElementById('main');
      clear(main);

      var list = el('ul', { className: 'reflow-pii-list' });
      (job.pii_findings || []).forEach(function (f) {
        list.appendChild(el('li', {}, [
          el('span', { className: 'reflow-pii-type', text: f.entity_type }),
          doc.createTextNode(': '),
          el('code', { text: maskPii(f.text) }),
          el('span', { className: 'reflow-pii-score', text: ' (confidence ' + Math.round((f.score || 0) * 100) + '%)' })
        ]));
      });

      var heading = el('h2', { id: 'reflow-pii-h', text: 'Possible personal information found' });
      var card = el('section', {
        className: 'reflow-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'reflow-pii-h'
      }, [
        heading,
        el('p', { text: 'Reflow found the items below. Continuing sends the document for full processing. Stop if this information should not be shared.' }),
        list,
        el('div', { className: 'reflow-actions' }, [
          el('button', { id: 'reflow-pii-go', className: 'reflow-btn', text: 'Continue processing' }),
          el('button', { id: 'reflow-pii-stop', className: 'reflow-btn reflow-btn-secondary', text: 'Stop and discard' })
        ])
      ]);
      main.appendChild(card);

      doc.getElementById('reflow-pii-go').onclick = function () { decide('approved'); };
      doc.getElementById('reflow-pii-stop').onclick = function () { decide('denied'); };
      heading.tabIndex = -1; heading.focus();

      function decide(decision) {
        setStatus(decision === 'approved' ? 'Resuming processing…' : 'Stopping…');
        var body = { decision: decision, reviewed_by: state.reviewerEmail };
        if (decision === 'denied') body.justification = 'User declined after PII review in Reflow Reader.';
        fetch(API + '/api/v1/approval/' + encodeURIComponent(job.approval_token) + '/decision', {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(body)
        }).then(handleJson).then(function () {
          if (decision === 'approved') beginPolling();
          else renderDenied('You chose not to continue after reviewing detected personal information.');
        }).catch(function (err) {
          showError('Could not record your decision.', err && err.message);
        });
      }
    }

    // ---------- result rendering ----------
    function loadResult(job) {
      setStatus('Formatting the accessible document…');
      var figures = job.figures || [];
      fetch(job.markdown_url).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status + ' fetching markdown');
        return r.text();
      }).then(function (md) {
        renderDocument(md, figures, job);
      }).catch(function (err) {
        showError('The document was processed but its content could not be loaded.', err && err.message);
      });
    }

    function renderDocument(md, figures, job) {
      var name = job.filename || state.filename || 'document';
      setTitle('Accessible view: ' + name);
      setStatus('Document ready.');

      var html = mdToHtml(md, buildFigureMap(figures));
      var main = doc.getElementById('main');
      clear(main);

      var article = el('article', { className: 'reflow-doc', 'aria-label': 'Remediated document' });
      article.innerHTML = sanitize(html);
      main.appendChild(article);

      if (figures.length) appendFiguresAppendix(article, figures);
      buildActions(name);
      main.focus();
    }

    function buildActions(name) {
      var bar = doc.getElementById('reflow-actions');
      clear(bar);
      bar.appendChild(el('button', { className: 'reflow-btn', text: 'Save as PDF', onclick: saveAsPdf }));
      bar.appendChild(el('button', { className: 'reflow-btn reflow-btn-secondary', text: 'Report an issue', onclick: function () { openFeedback(name); } }));
    }

    function renderDenied(reason) {
      setTitle('Processing stopped');
      setStatus('Processing was stopped.');
      var main = doc.getElementById('main');
      clear(main);
      main.appendChild(el('section', { className: 'reflow-card' }, [
        el('h2', { text: 'Processing stopped' }),
        el('p', { text: reason || 'The document was not processed.' })
      ]));
      main.focus();
    }

    // ---------- Save as PDF (print) ----------
    function saveAsPdf() {
      // Reflect current form values into attributes so they appear in print.
      var inputs = doc.querySelectorAll('.reflow-doc input, .reflow-doc textarea, .reflow-doc select');
      Array.prototype.forEach.call(inputs, function (n) {
        if (n.tagName === 'TEXTAREA') { n.textContent = n.value; }
        else if (n.type === 'checkbox' || n.type === 'radio') {
          if (n.checked) n.setAttribute('checked', 'checked'); else n.removeAttribute('checked');
        } else if (n.tagName === 'SELECT') {
          Array.prototype.forEach.call(n.options, function (o) {
            if (o.selected) o.setAttribute('selected', 'selected'); else o.removeAttribute('selected');
          });
        } else { n.setAttribute('value', n.value); }
      });
      window.print();
    }

    // ---------- Feedback ----------
    function openFeedback(name) {
      var main = doc.getElementById('main');
      var prev = main.innerHTML; // not used to restore; we overlay a card instead
      var cat = el('select', { id: 'reflow-fb-cat' }, ['content', 'formatting', 'accessibility', 'structure', 'other'].map(function (c) {
        return el('option', { value: c, text: c });
      }));
      cat.value = 'accessibility';
      var desc = el('textarea', { id: 'reflow-fb-desc', rows: 5, 'aria-describedby': 'reflow-fb-hint' });

      var card = el('section', {
        className: 'reflow-card reflow-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'reflow-fb-h'
      }, [
        el('h2', { id: 'reflow-fb-h', text: 'Report an issue' }),
        el('label', { for: 'reflow-fb-cat', text: 'Category' }), cat,
        el('label', { for: 'reflow-fb-desc', text: 'What is wrong? (10+ characters)' }), desc,
        el('p', { id: 'reflow-fb-hint', className: 'reflow-hint', text: 'Sent to the Equalify Reflow feedback service.' }),
        el('div', { className: 'reflow-actions' }, [
          el('button', { className: 'reflow-btn', text: 'Send', onclick: send }),
          el('button', { className: 'reflow-btn reflow-btn-secondary', text: 'Cancel', onclick: close })
        ])
      ]);
      doc.body.appendChild(card);
      card.querySelector('h2').tabIndex = -1;
      card.querySelector('h2').focus();

      function close() { card.remove(); }
      function send() {
        var text = desc.value.trim();
        if (text.length < 10) { desc.focus(); return; }
        fetch(API + '/api/v1/feedback', {
          method: 'POST',
          headers: authHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            category: cat.value,
            description: text,
            document_title: name,
            website: PDF_URL
          })
        }).then(function () {
          close();
          setStatus('Thank you — your report was sent.');
        }).catch(function () {
          close();
          setStatus('Your report could not be sent right now.');
        });
      }
    }

    // ---------- helpers ----------
    function handleJson(r) {
      if (r.status === 401 || r.status === 403) throw tag({ message: 'unauthorized' }, 'authFailed');
      return r.text().then(function (t) {
        var data = t ? JSON.parse(t) : {};
        if (!r.ok) throw new Error((data && data.detail) ? JSON.stringify(data.detail) : ('HTTP ' + r.status));
        return data;
      });
    }
    function tag(obj, flag) { obj = obj || {}; obj[flag] = true; return obj; }
    function guessName(url) {
      try {
        var p = new URL(url).pathname.split('/').pop();
        return (p && /\.pdf$/i.test(p)) ? p : (p || 'document.pdf');
      } catch (e) { return 'document.pdf'; }
    }
    function maskPii(t) {
      t = String(t || '');
      if (t.length <= 4) return t.replace(/./g, '•');
      return t.slice(0, 2) + t.slice(2, -2).replace(/[^\s]/g, '•') + t.slice(-2);
    }
    function buildFigureMap(figures) {
      var m = {};
      (figures || []).forEach(function (f) { m[f.figure_id] = f; });
      return m;
    }
    function appendFiguresAppendix(article, figures) {
      // Only add figures the markdown did not already place by id.
      var placed = {};
      Array.prototype.forEach.call(article.querySelectorAll('img'), function (img) {
        placed[img.getAttribute('src')] = true;
      });
      var missing = figures.filter(function (f) { return !placed[f.url]; });
      if (!missing.length) return;
      var sec = el('section', { className: 'reflow-figures', 'aria-label': 'Figures' }, [el('h2', { text: 'Figures' })]);
      missing.forEach(function (f) {
        var fig = el('figure', {}, [
          el('img', { src: f.url, alt: f.alt_text || ('Figure on page ' + f.page) })
        ]);
        if (f.caption) fig.appendChild(el('figcaption', { text: f.caption }));
        sec.appendChild(fig);
      });
      article.appendChild(sec);
    }

    // ---------- markdown -> HTML (compact, GFM-ish, raw HTML pass-through) ----------
    function mdToHtml(src, figMap) {
      var lines = String(src).replace(/\r\n?/g, '\n').split('\n');
      var out = [], i = 0;

      function inline(s) {
        return s
          .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, function (_, alt, url) {
            var f = figMap[url];
            var src = f ? f.url : url;
            var a = f && f.alt_text ? f.alt_text : alt;
            return '<img src="' + esc(src) + '" alt="' + esc(a) + '">';
          })
          .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, '<a href="$2">$1</a>')
          .replace(/`([^`]+)`/g, function (_, c) { return '<code>' + esc(c) + '</code>'; })
          .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
          .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
          .replace(/__([^_]+)__/g, '<strong>$1</strong>');
      }

      while (i < lines.length) {
        var line = lines[i];

        if (/^\s*$/.test(line)) { i++; continue; }

        // Raw HTML block — pass through verbatim (covers Reflow's HTML forms).
        if (/^\s*<(\/?)([a-zA-Z][a-zA-Z0-9]*)/.test(line)) {
          out.push(line); i++;
          continue;
        }

        // Fenced code
        var fence = line.match(/^\s*```(.*)$/);
        if (fence) {
          var code = []; i++;
          while (i < lines.length && !/^\s*```/.test(lines[i])) { code.push(lines[i]); i++; }
          i++;
          out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>');
          continue;
        }

        // Heading
        var h = line.match(/^(#{1,6})\s+(.*)$/);
        if (h) { var lv = h[1].length; out.push('<h' + lv + '>' + inline(h[2].trim()) + '</h' + lv + '>'); i++; continue; }

        // Horizontal rule
        if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line)) { out.push('<hr>'); i++; continue; }

        // Table (GFM pipe)
        if (line.indexOf('|') !== -1 && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].indexOf('-') !== -1) {
          var head = splitRow(line);
          i += 2;
          var rows = [];
          while (i < lines.length && lines[i].indexOf('|') !== -1 && !/^\s*$/.test(lines[i])) {
            rows.push(splitRow(lines[i])); i++;
          }
          out.push(renderTable(head, rows, inline));
          continue;
        }

        // Blockquote
        if (/^\s*>\s?/.test(line)) {
          var q = [];
          while (i < lines.length && /^\s*>\s?/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
          out.push('<blockquote>' + mdToHtml(q.join('\n'), figMap) + '</blockquote>');
          continue;
        }

        // Lists (one level; ordered or unordered)
        if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
          var ordered = /^\s*\d+\.\s+/.test(line);
          var items = [];
          while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
            items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, '')); i++;
          }
          out.push('<' + (ordered ? 'ol' : 'ul') + '>' +
            items.map(function (it) { return '<li>' + inline(it) + '</li>'; }).join('') +
            '</' + (ordered ? 'ol' : 'ul') + '>');
          continue;
        }

        // Paragraph (gather consecutive plain lines)
        var para = [];
        while (i < lines.length && !/^\s*$/.test(lines[i]) &&
          !/^\s*(#{1,6}\s|```|>|[-*+]\s|\d+\.\s|<)/.test(lines[i])) {
          para.push(lines[i]); i++;
        }
        out.push('<p>' + inline(para.join(' ').trim()) + '</p>');
      }
      return out.join('\n');

      function splitRow(s) {
        return s.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(function (c) { return c.trim(); });
      }
      function renderTable(head, rows, inl) {
        var th = '<thead><tr>' + head.map(function (c) { return '<th>' + inl(c) + '</th>'; }).join('') + '</tr></thead>';
        var tb = '<tbody>' + rows.map(function (r) {
          return '<tr>' + r.map(function (c) { return '<td>' + inl(c) + '</td>'; }).join('') + '</tr>';
        }).join('') + '</tbody>';
        return '<table>' + th + tb + '</table>';
      }
    }

    function esc(s) {
      return String(s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }

    // ---------- sanitizer ----------
    // Removes scripts, event handlers, and javascript: URLs while KEEPING
    // form controls (input/select/textarea/button/label/form) so users can
    // fill out forms returned by Reflow. Data stays separate from the original
    // document: it lives only in this window's DOM.
    function sanitize(html) {
      var tpl = doc.createElement('template');
      tpl.innerHTML = html;
      var nodes = tpl.content.querySelectorAll('*');
      Array.prototype.forEach.call(nodes, function (n) {
        var tag = n.tagName.toLowerCase();
        if (tag === 'script' || tag === 'style' || tag === 'iframe' || tag === 'object' || tag === 'embed') {
          n.remove(); return;
        }
        Array.prototype.slice.call(n.attributes).forEach(function (a) {
          var name = a.name.toLowerCase(), val = a.value;
          if (name.indexOf('on') === 0) { n.removeAttribute(a.name); return; }
          if ((name === 'href' || name === 'src' || name === 'action' || name === 'formaction') &&
            /^\s*javascript:/i.test(val)) {
            n.removeAttribute(a.name);
          }
        });
        // Force forms to not navigate away; keep their fields usable.
        if (tag === 'form') { n.setAttribute('onsubmit', ''); n.removeAttribute('onsubmit'); n.setAttribute('action', '#'); }
        if (tag === 'a' && n.getAttribute('href')) { n.setAttribute('rel', 'noopener noreferrer'); n.setAttribute('target', '_blank'); }
      });
      return tpl.innerHTML;
    }

    // ---------- styles ----------
    var STYLES = [
      ':root{--fg:#111;--bg:#fff;--accent:#0b5fff;--muted:#555;--line:#ddd;--err:#b00020}',
      '@media (prefers-color-scheme:dark){:root{--fg:#eee;--bg:#161616;--accent:#7aa2ff;--muted:#aaa;--line:#333;--err:#ff8a9b}}',
      '*{box-sizing:border-box}',
      'body{margin:0;font:18px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--fg);background:var(--bg)}',
      '.reflow-skip{position:absolute;left:-999px;top:0;background:var(--accent);color:#fff;padding:.5rem 1rem;z-index:10}',
      '.reflow-skip:focus{left:0}',
      '.reflow-bar{display:flex;flex-wrap:wrap;gap:1rem;align-items:center;justify-content:space-between;padding:.75rem 1rem;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:5}',
      '.reflow-bar h1{font-size:1.1rem;margin:0}',
      '.reflow-actions{display:flex;gap:.5rem;flex-wrap:wrap}',
      '#reflow-status{margin:0;padding:.5rem 1rem;color:var(--muted)}',
      '.reflow-error{margin:1rem;padding:1rem;border:2px solid var(--err);border-radius:8px;color:var(--err)}',
      '.reflow-error pre{white-space:pre-wrap;word-break:break-all;color:var(--muted)}',
      'main{padding:1rem;max-width:46rem;margin:0 auto}',
      'main:focus{outline:none}',
      '.reflow-card{max-width:36rem;margin:1.5rem auto;padding:1.25rem;border:1px solid var(--line);border-radius:10px}',
      '.reflow-overlay{position:fixed;inset:auto 1rem 1rem 1rem;max-width:36rem;margin:0 auto;background:var(--bg);box-shadow:0 8px 40px rgba(0,0,0,.3);z-index:20}',
      '.reflow-card label{display:block;margin:.75rem 0 .25rem;font-weight:600}',
      '.reflow-card input,.reflow-card textarea,.reflow-card select{width:100%;padding:.6rem;font:inherit;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}',
      '.reflow-btn{font:inherit;font-weight:600;padding:.6rem 1rem;min-height:44px;border:0;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer}',
      '.reflow-btn-secondary{background:transparent;color:var(--accent);border:1px solid var(--accent)}',
      '.reflow-btn:focus-visible,a:focus-visible{outline:3px solid var(--accent);outline-offset:2px}',
      '.reflow-hint{color:var(--muted);font-size:.9rem}',
      '.reflow-pii-list{list-style:none;padding:0}',
      '.reflow-pii-list li{padding:.4rem 0;border-bottom:1px solid var(--line)}',
      '.reflow-pii-type{font-weight:700;text-transform:capitalize}',
      '.reflow-pii-score{color:var(--muted)}',
      '.reflow-doc img{max-width:100%;height:auto}',
      '.reflow-doc table{border-collapse:collapse;width:100%;margin:1rem 0}',
      '.reflow-doc th,.reflow-doc td{border:1px solid var(--line);padding:.5rem;text-align:left}',
      '.reflow-doc input,.reflow-doc textarea,.reflow-doc select{font:inherit;padding:.4rem;border:1px solid var(--line);border-radius:6px;margin:.25rem 0;max-width:100%}',
      '.reflow-doc label{font-weight:600}',
      '.reflow-figures figure{margin:1rem 0}',
      'blockquote{border-left:4px solid var(--line);margin:1rem 0;padding:.25rem 1rem;color:var(--muted)}',
      'pre{background:rgba(127,127,127,.12);padding:1rem;overflow:auto;border-radius:8px}',
      '@media print{.reflow-bar,#reflow-status,.reflow-skip,.reflow-actions,.reflow-error{display:none!important}main{max-width:none}}'
    ].join('');

    // ---------- go ----------
    buildChrome();
    ensureCredentials(start);
  }
})();
