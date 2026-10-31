// Groups unpinned tabs that share a website into one collapsible tab group.
(function () {
  if (window.SameTabGroup?.started) {
    return;
  }

  const ATTR = "same-tab-group";
  const GROUPED = "same-tab-grouped";
  const RELEASED = "same-tab-released";
  const DISSOLVING = "same-tab-dissolving";
  const ENABLED_PREF = "same-tab-group.enabled";

  function enabled() {
    try {
      return Services.prefs.getBoolPref(ENABLED_PREF, true);
    } catch (error) {
      return true;
    }
  }

  function pageURI(tab) {
    try {
      const uri = tab.linkedBrowser?.currentURI;
      if (uri?.spec && uri.spec !== "about:blank") {
        return uri;
      }
    } catch (error) {
      return null;
    }
    return null;
  }

  function hostKey(tab) {
    const uri = pageURI(tab);
    if (!uri || (uri.scheme !== "http" && uri.scheme !== "https") || !uri.host) {
      return "";
    }
    return uri.host.replace(/^www\./i, "").toLowerCase();
  }

  function workspaceId(tab) {
    return tab.getAttribute("zen-workspace-id") || "";
  }

  function skipped(tab) {
    if (!tab || tab.pinned || tab.closing) {
      return true;
    }
    if (
      tab.hasAttribute("zen-essential") ||
      tab.hasAttribute("zen-empty-tab") ||
      tab.hasAttribute("zen-glance-tab")
    ) {
      return true;
    }
    const group = tab.group;
    if (!group) {
      return false;
    }
    const tag = (group.localName || "").toLowerCase();
    if (tag === "zen-folder" || group.hasAttribute("split-view-group")) {
      return true;
    }
    if (tag === "tab-group" && !group.hasAttribute(ATTR)) {
      return true;
    }
    return false;
  }

  function groupLabel(tabs, host) {
    const heads = tabs
      .map(tab => (tab.label || "").split(/\s+[|｜]\s+/)[0].trim())
      .filter(Boolean);
    if (heads.length && heads.every(head => head === heads[0]) && heads[0].length <= 24) {
      return heads[0];
    }
    const name = host.split(".")[0];
    return name.charAt(0).toUpperCase() + name.slice(1);
  }

  function findGroup(host, space) {
    for (const group of document.querySelectorAll(`tab-group[${ATTR}]`)) {
      if (
        group.getAttribute(ATTR) === host &&
        (group.getAttribute("zen-workspace-id") || "") === space
      ) {
        return group;
      }
    }
    return null;
  }

  function realTabs(group) {
    return [...(group.tabs || [])].filter(
      tab => tab && !tab.hasAttribute("zen-empty-tab") && !tab.closing
    );
  }

  function dissolve(group) {
    group.setAttribute(DISSOLVING, "1");
    for (const tab of realTabs(group)) {
      tab.setAttribute(DISSOLVING, "1");
    }
    try {
      group.ungroupTabs();
    } catch (error) {
      console.warn("[SameTabGroup] Could not ungroup:", error);
    }
    if (group.isConnected) {
      group.remove();
    }
  }

  let busy = false;

  function groupSameTabs() {
    if (busy || !enabled() || !window.gBrowser) {
      return;
    }
    busy = true;
    try {
      const buckets = new Map();
      for (const tab of gBrowser.tabs) {
        if (skipped(tab)) {
          continue;
        }
        const host = hostKey(tab);
        if (!host) {
          continue;
        }
        if (tab.getAttribute(RELEASED) === host) {
          continue;
        }
        if (tab.hasAttribute(RELEASED) && tab.getAttribute(RELEASED) !== host) {
          tab.removeAttribute(RELEASED);
        }
        const space = workspaceId(tab);
        const key = `${space}\n${host}`;
        if (!buckets.has(key)) {
          buckets.set(key, []);
        }
        buckets.get(key).push(tab);
      }

      for (const [key, looseTabs] of buckets) {
        const space = key.slice(0, key.indexOf("\n"));
        const host = key.slice(key.indexOf("\n") + 1);
        const group = findGroup(host, space);
        const members = group ? realTabs(group) : [];
        const incoming = looseTabs.filter(tab => !members.includes(tab));
        const total = members.length + incoming.length;
        if (total < 2) {
          continue;
        }

        incoming.sort((a, b) => (a._tPos ?? 0) - (b._tPos ?? 0));
        if (!group) {
          const created = document.createXULElement("tab-group");
          created.id = `same-${Date.now()}-${Math.round(Math.random() * 1000)}`;
          created.setAttribute(ATTR, host);
          if (space) {
            created.setAttribute("zen-workspace-id", space);
          }
          incoming[0].before(created);
          created.label = groupLabel(incoming, host);
          created.addTabs(incoming);
          for (const tab of incoming) {
            tab.setAttribute(GROUPED, host);
          }
          if (!incoming.some(tab => tab.selected)) {
            created.collapsed = true;
          }
          continue;
        }

        if (incoming.length) {
          group.addTabs(incoming);
          for (const tab of incoming) {
            tab.setAttribute(GROUPED, host);
          }
          if (incoming.some(tab => tab.selected)) {
            group.collapsed = false;
          }
        }
      }

      for (const group of [...document.querySelectorAll(`tab-group[${ATTR}]`)]) {
        if (realTabs(group).length < 2) {
          dissolve(group);
        }
      }
    } catch (error) {
      console.error("[SameTabGroup]", error);
    } finally {
      busy = false;
    }
  }

  let timer = 0;
  function schedule() {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(groupSameTabs, 400);
  }

  function onUngrouped(event) {
    const tab = event.target;
    if (!tab || tab.localName !== "tab") {
      return;
    }
    if (tab.hasAttribute(DISSOLVING)) {
      tab.removeAttribute(DISSOLVING);
      tab.removeAttribute(GROUPED);
      return;
    }
    const host = tab.getAttribute(GROUPED);
    if (!host) {
      return;
    }
    tab.setAttribute(RELEASED, host);
    tab.removeAttribute(GROUPED);
  }

  function ensureMenu() {
    const menu = document.getElementById("tabContextMenu");
    if (!menu || document.getElementById("same-tab-group-menuitem")) {
      return;
    }
    const item = document.createXULElement("menuitem");
    item.id = "same-tab-group-menuitem";
    item.setAttribute("label", "把相同网站收成一组");
    menu.appendChild(item);
    item.addEventListener("command", () => {
      const tab = window.TabContextMenu?.contextTab || gBrowser.selectedTab;
      const host = hostKey(tab);
      if (!host) {
        return;
      }
      for (const candidate of gBrowser.tabs) {
        if (hostKey(candidate) === host) {
          candidate.removeAttribute(RELEASED);
        }
      }
      schedule();
    });
  }

  const container = gBrowser.tabContainer;
  for (const type of ["TabOpen", "TabClose", "TabAttrModified", "TabUngrouped"]) {
    container.addEventListener(type, event => {
      if (type === "TabUngrouped") {
        onUngrouped(event);
      }
      schedule();
    });
  }
  ensureMenu();
  setTimeout(schedule, 1500);
  setTimeout(schedule, 4000);

  window.SameTabGroup = { started: true, run: groupSameTabs };
})();
