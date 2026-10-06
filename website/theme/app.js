// Docs runtime: theme toggle, search, TOC highlighting, mobile nav.
// No dependencies, no network.
(function () {
  var root = document.documentElement;
  var KEY = "canopoddocs.theme";

  /** The theme actually on screen: an explicit choice, else the OS preference. */
  function current() {
    if (root.dataset.theme === "light" || root.dataset.theme === "dark") return root.dataset.theme;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  var toggle = document.getElementById("theme");
  if (toggle) {
    toggle.addEventListener("click", function () {
      var next = current() === "dark" ? "light" : "dark";
      root.dataset.theme = next;
      try {
        localStorage.setItem(KEY, next);
      } catch (e) {}
    });
  }

  var menu = document.getElementById("menu");
  var side = document.getElementById("side");
  if (menu && side) {
    var mobileNav = window.matchMedia("(max-width: 860px)");
    function setMenu(open) {
      side.classList.toggle("open", open);
      menu.setAttribute("aria-expanded", String(open));
      menu.setAttribute("aria-label", open ? "Close documentation navigation" : "Open documentation navigation");
      side.inert = mobileNav.matches && !open;
    }
    setMenu(false);
    mobileNav.addEventListener("change", function () { setMenu(false); });
    menu.addEventListener("click", function () {
      setMenu(!side.classList.contains("open"));
    });
    side.addEventListener("click", function (e) {
      if (e.target.closest("a")) setMenu(false);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && side.classList.contains("open")) {
        setMenu(false);
        menu.focus();
      }
    });
  }

  /* ── search ──────────────────────────────────────────────────────── */
  var q = document.getElementById("q");
  var box = document.getElementById("results");
  var index = null;
  var at = -1;
  var hits = [];

  function load() {
    if (index) return Promise.resolve(index);
    return fetch("search-index.json")
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        index = j;
        return j;
      })
      .catch(function () {
        index = [];
        return index;
      });
  }

  function score(page, needle) {
    var t = page.title.toLowerCase();
    if (t.indexOf(needle) === 0) return 0;
    if (t.indexOf(needle) >= 0) return 1;
    for (var i = 0; i < page.headings.length; i++) {
      if (page.headings[i].toLowerCase().indexOf(needle) >= 0) return 2 + i / 100;
    }
    if ((page.description || "").toLowerCase().indexOf(needle) >= 0) return 4;
    if (page.text.toLowerCase().indexOf(needle) >= 0) return 5;
    return -1;
  }

  function heading(page, needle) {
    for (var i = 0; i < page.headings.length; i++) {
      if (page.headings[i].toLowerCase().indexOf(needle) >= 0) return page.headings[i];
    }
    return page.group;
  }

  function slugifyHeading(text) {
    return text
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-");
  }

  function paint() {
    if (!hits.length) {
      box.innerHTML = '<div class="none">Nothing matches that.</div>';
      box.hidden = false;
      return;
    }
    box.innerHTML = hits
      .map(function (h, i) {
        return (
          '<a class="' + (i === at ? "on" : "") + '" href="' + h.href + '"><b>' + h.title + "</b><span>" + h.sub + "</span></a>"
        );
      })
      .join("");
    box.hidden = false;
  }

  if (q && box) {
    q.addEventListener("input", function () {
      var needle = q.value.trim().toLowerCase();
      if (needle.length < 2) {
        box.hidden = true;
        hits = [];
        return;
      }
      load().then(function (pages) {
        hits = pages
          .map(function (p) {
            return { p: p, s: score(p, needle) };
          })
          .filter(function (r) {
            return r.s >= 0;
          })
          .sort(function (a, b) {
            return a.s - b.s;
          })
          .slice(0, 12)
          .map(function (r) {
            var h = heading(r.p, needle);
            var anchor = r.p.headings.indexOf(h) >= 0 ? "#" + slugifyHeading(h) : "";
            return { title: r.p.title, sub: r.p.group + " · " + h, href: r.p.slug + ".html" + anchor };
          });
        at = hits.length ? 0 : -1;
        paint();
      });
    });

    q.addEventListener("keydown", function (e) {
      if (box.hidden) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        at = Math.min(hits.length - 1, at + 1);
        paint();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        at = Math.max(0, at - 1);
        paint();
      } else if (e.key === "Enter" && hits[at]) {
        e.preventDefault();
        location.href = hits[at].href;
      } else if (e.key === "Escape") {
        box.hidden = true;
        q.blur();
      }
    });

    document.addEventListener("click", function (e) {
      if (!box.contains(e.target) && e.target !== q) box.hidden = true;
    });

    document.addEventListener("keydown", function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        q.focus();
        q.select();
      } else if (e.key === "/" && document.activeElement !== q) {
        e.preventDefault();
        q.focus();
      }
    });
  }

  /* ── TOC highlighting ────────────────────────────────────────────── */
  var links = [].slice.call(document.querySelectorAll(".toc a"));
  if (links.length && "IntersectionObserver" in window) {
    var byId = {};
    links.forEach(function (a) {
      byId[a.getAttribute("href").slice(1)] = a;
    });
    var seen = {};
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (en) {
          seen[en.target.id] = en.isIntersecting;
        });
        var first = null;
        Object.keys(byId).forEach(function (id) {
          if (!first && seen[id]) first = id;
        });
        links.forEach(function (a) {
          a.classList.toggle("on", first && a.getAttribute("href") === "#" + first);
        });
      },
      { rootMargin: "-70px 0px -70% 0px" },
    );
    Object.keys(byId).forEach(function (id) {
      var el = document.getElementById(id);
      if (el) io.observe(el);
    });
  }
})();
